// A single durable owner per slug selects the first URL/card before any KV
// writes. KV is only the public read replica; it cannot implement put-if-absent.
import {
  validateTarget, validateCard, slugFor, cardKey, deriveCardMeta,
  packRecord, parseRecord,
} from "./lib.mjs";

export class LinkCreator {
  constructor(state, env) {
    this.sql = state.storage.sql;
    this.env = env;
    this.tail = Promise.resolve();
    this.sql.exec(`CREATE TABLE IF NOT EXISTS link (
      id INTEGER PRIMARY KEY CHECK (id = 1), record TEXT NOT NULL,
      card BLOB, published INTEGER NOT NULL DEFAULT 0
    )`);
  }

  fetch(request) {
    // Network I/O opens input gates. Serialize the entire operation, including
    // recovery, and keep a rejected request from poisoning the queue.
    const result = this.tail.then(() => this.create(request));
    this.tail = result.catch(() => {});
    return result;
  }

  async create(request) {
    const { url, card: encodedCard } = await request.json();
    if (!validateTarget(url).ok) return new Response(null, { status: 400 });
    const card = encodedCard == null ? null : validateCard(encodedCard);
    if (card && !card.ok) return new Response(null, { status: 400 });
    const slug = await slugFor(url);
    let row = this.sql.exec("SELECT * FROM link WHERE id = 1").toArray()[0];
    if (!row) {
      // Import an existing link without changing it. No bulk migration or
      // deletion of the production namespace is necessary.
      const existing = await this.env.LINKS.get(slug);
      if (existing !== null) {
        if (parseRecord(existing).url !== url) return new Response(null, { status: 409 });
        this.sql.exec("INSERT INTO link (id, record, card, published) VALUES (1, ?, NULL, 1)", existing);
      } else {
        const record = packRecord(url, await deriveCardMeta(url), card !== null);
        // One atomic SQLite write reserves BOTH the record and image. Unlike
        // DO key-value values, a SQLite row can hold the maximum URL + PNG.
        this.sql.exec("INSERT INTO link (id, record, card, published) VALUES (1, ?, ?, 0)",
          record, card ? card.bytes.buffer : null);
      }
      row = this.sql.exec("SELECT * FROM link WHERE id = 1").toArray()[0];
    }
    if (parseRecord(row.record).url !== url) return new Response(null, { status: 409 });
    if (!row.published) {
      // A failed write or object eviction leaves the durable reservation intact.
      // Retrying always republishes the ORIGINAL choice, never the retry's card.
      if (row.card !== null) await this.env.LINKS.put(cardKey(slug), new Uint8Array(row.card));
      await this.env.LINKS.put(slug, row.record);
      this.sql.exec("UPDATE link SET published = 1, card = NULL WHERE id = 1");
    }
    return new Response(null, { status: 204 });
  }
}
