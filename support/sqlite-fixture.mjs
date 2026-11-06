import { DatabaseSync } from "node:sqlite";
import { LinkCreator } from "../src/creator.mjs";

// Real SQLite for coordinator unit tests; network and KV faults remain controlled.
export function creatorState() {
  const db = new DatabaseSync(":memory:");
  return { storage: { sql: { exec(query, ...bindings) {
    const statement = db.prepare(query);
    const values = bindings.map(v => v instanceof ArrayBuffer ? new Uint8Array(v) : v);
    if (query.startsWith("SELECT")) {
      const rows = statement.all(...values).map(row => ({ ...row,
        card: row.card instanceof Uint8Array ? row.card.buffer.slice(row.card.byteOffset, row.card.byteOffset + row.card.byteLength) : row.card,
      }));
      return { toArray: () => rows };
    }
    statement.run(...values);
    return { toArray: () => [] };
  } } } };
}

export function creatorNamespace(LINKS) {
  const owners = new Map();
  const states = new Map();
  return {
    idFromName: slug => slug,
    get(slug) {
      if (!owners.has(slug)) {
        if (!states.has(slug)) states.set(slug, creatorState());
        owners.set(slug, new LinkCreator(states.get(slug), { LINKS }));
      }
      return { fetch: (url, init) => owners.get(slug).fetch(new Request(url, init)) };
    },
    evict: slug => owners.delete(slug),
  };
}
