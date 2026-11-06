import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import worker from "../src/worker.mjs";
import { creatorNamespace } from "../support/sqlite-fixture.mjs";
import {
  slugFor,
  cardKey,
  inlineScriptHash,
  MAX_URL_LENGTH,
  MAX_REQUEST_BYTES,
  CARD_DESC,
  GENERIC_TITLE,
  CARD_WIDTH,
  CARD_HEIGHT,
} from "../src/lib.mjs";

// Minimal in-memory stand-in for a Workers KV namespace (the two methods the
// worker uses). Counts puts so dedupe behavior is observable.
function kvStub() {
  const store = new Map();
  return {
    store,
    puts: 0,
    async get(key, type) {
      if (!store.has(key)) return null;
      const value = store.get(key);
      // Mirror real KV: "arrayBuffer" reads return an ArrayBuffer.
      if (type === "arrayBuffer") {
        return value instanceof Uint8Array
          ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
          : new TextEncoder().encode(value).buffer;
      }
      return value;
    },
    async put(key, value) {
      this.puts += 1;
      store.set(key, value);
    },
  };
}

const BASE = "https://nanolink.example";

const namespaces = new WeakMap();
function call(env, path, init) {
  if (!env.CREATORS && env.LINKS) {
    if (!namespaces.has(env.LINKS)) namespaces.set(env.LINKS, creatorNamespace(env.LINKS));
    env = { ...env, CREATORS: namespaces.get(env.LINKS) };
  }
  return worker.fetch(new Request(BASE + path, init), env);
}

function postLink(env, body) {
  return call(env, "/api/links", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://nanoodle.com" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const GOOD_URL = "https://nanoodle.com/play#a=" + "Z".repeat(20000); // realistically long

// --- POST /api/links --------------------------------------------------------

test("POST /api/links stores and returns slug + shortUrl", async () => {
  const LINKS = kvStub();
  const res = await postLink({ LINKS }, { url: GOOD_URL });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://nanoodle.com");
  const body = await res.json();
  assert.equal(body.slug, await slugFor(GOOD_URL));
  assert.equal(body.shortUrl, `${BASE}/${body.slug}`);
  // v2 KV shape: a JSON record. GOOD_URL's #a= fragment is not decodable
  // (it's just Zs), so the metadata is null — and the POST still succeeded.
  assert.deepEqual(JSON.parse(LINKS.store.get(body.slug)), {
    url: GOOD_URL,
    title: null,
    desc: null,
  });
});

test("POST is deterministic and never stores twice", async () => {
  const LINKS = kvStub();
  const first = await (await postLink({ LINKS }, { url: GOOD_URL })).json();
  const second = await (await postLink({ LINKS }, { url: GOOD_URL })).json();
  assert.deepEqual(first, second);
  assert.equal(LINKS.puts, 1);
  assert.equal(LINKS.store.size, 1);
});

test("POST rejects off-origin, oversized, and malformed targets", async () => {
  const LINKS = kvStub();
  const cases = [
    { url: "https://nanoodle.com.evil.tld/play" },
    { url: "https://evil.tld/?u=https://nanoodle.com/" },
    { url: "http://nanoodle.com/" },
    { url: "https://nanoodle.com/#" + "x".repeat(MAX_URL_LENGTH) },
    { url: 42 },
    {},
    null,
  ];
  for (const body of cases) {
    const res = await postLink({ LINKS }, body);
    assert.equal(res.status, 400, JSON.stringify(body)?.slice(0, 60));
    assert.ok((await res.json()).error);
  }
  const notJson = await postLink({ LINKS }, "not json at all");
  assert.equal(notJson.status, 400);
  assert.equal(LINKS.puts, 0);
});

test("GET /api/links is method-not-allowed", async () => {
  const res = await call({ LINKS: kvStub() }, "/api/links", { method: "GET" });
  assert.equal(res.status, 405);
});

test("OPTIONS preflight answers with CORS headers", async () => {
  const res = await call({ LINKS: kvStub() }, "/api/links", {
    method: "OPTIONS",
    headers: {
      origin: "https://nanoodle.com",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://nanoodle.com");
  assert.match(res.headers.get("access-control-allow-methods"), /POST/);
  assert.match(res.headers.get("access-control-allow-headers"), /content-type/);
});

// --- GET /<slug> (body bounce) -----------------------------------------------

test("GET /<slug> returns a 200 body-bounce page, not a redirect", async () => {
  const LINKS = kvStub();
  const { slug } = await (await postLink({ LINKS }, { url: GOOD_URL })).json();

  const res = await call({ LINKS }, `/${slug}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("location"), null); // the whole point
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");

  const page = await res.text();
  assert.ok(page.includes(GOOD_URL)); // GOOD_URL has no HTML-special chars
  assert.match(page, /http-equiv="refresh"/);
  assert.match(page, /location\.replace\(/);
  assert.match(page, /Continue to nanoodle/);

  // CSP: locked down, and the only allowed script is the page's own inline
  // bounce script, allowlisted by the sha256 of its exact emitted source.
  const cspHeader = res.headers.get("content-security-policy");
  assert.match(cspHeader, /default-src 'none'/);
  assert.match(cspHeader, /base-uri 'none'/);
  const scriptSrc = cspHeader.match(/script-src ('sha256-[A-Za-z0-9+/=]+')/)?.[1];
  assert.ok(scriptSrc, "script-src is hash-based, not unsafe-inline");
  const source = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.equal(scriptSrc, await inlineScriptHash(source), "hash covers the emitted script");
});

test("GET unknown slug is an uncached 404 page", async () => {
  const res = await call({ LINKS: kvStub() }, "/AAAAAAAA");
  assert.equal(res.status, 404);
  assert.match(await res.text(), /Link not found/);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("GET non-slug paths 404 without touching KV", async () => {
  const LINKS = kvStub();
  let gets = 0;
  LINKS.get = async () => (gets++, null);
  for (const p of ["/too-long-to-be-a-slug", "/short", "/a/b", "/AAAA*AAA"]) {
    assert.equal((await call({ LINKS }, p)).status, 404, p);
  }
  assert.equal(gets, 0);
});

test("GET / serves the landing page", async () => {
  const res = await call({ LINKS: kvStub() }, "/");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /nanolink/);
});

test("scriptless pages (home, 404) get a CSP with no script-src at all", async () => {
  for (const p of ["/", "/AAAAAAAA"]) {
    const res = await call({ LINKS: kvStub() }, p);
    const cspHeader = res.headers.get("content-security-policy");
    assert.match(cspHeader, /default-src 'none'/, p);
    assert.ok(!cspHeader.includes("script-src"), p);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", p);
  }
});

// --- GET /api/links/<slug> (peek) ----------------------------------------------

test("peek returns the stored url with CORS", async () => {
  const LINKS = kvStub();
  const { slug } = await (await postLink({ LINKS }, { url: GOOD_URL })).json();
  const res = await call({ LINKS }, `/api/links/${slug}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://nanoodle.com");
  assert.deepEqual(await res.json(), { url: GOOD_URL });
});

test("peek 404s on unknown or malformed slugs", async () => {
  const LINKS = kvStub();
  assert.equal((await call({ LINKS }, "/api/links/AAAAAAAA")).status, 404);
  assert.equal((await call({ LINKS }, "/api/links/nope")).status, 404);
});

test("peek rejects non-GET", async () => {
  const res = await call({ LINKS: kvStub() }, "/api/links/AAAAAAAA", { method: "DELETE" });
  assert.equal(res.status, 405);
});

// --- v2: link-preview cards -----------------------------------------------------

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

const GRAPH = {
  v: 1,
  nodes: [
    { id: "n1", type: "text", x: 0, y: 0, fields: { text: "hi" } },
    { id: "n2", type: "llm", x: 1, y: 0, fields: {} },
    { id: "n3", type: "image", x: 2, y: 0, fields: {} },
  ],
  links: [
    { id: "l1", from: { node: "n1", port: "text" }, to: { node: "n2", port: "prompt" } },
    { id: "l2", from: { node: "n2", port: "text" }, to: { node: "n3", port: "prompt" } },
  ],
  nid: 4, lid: 3, view: { panX: 0, panY: 0, scale: 1 },
};

const GRAPH_URL = "https://nanoodle.com/#g=" + b64url(gzipSync(JSON.stringify(GRAPH)));

test("store + bounce a #g= link: derived chain title in the OG card", async () => {
  const LINKS = kvStub();
  const { slug } = await (await postLink({ LINKS }, { url: GRAPH_URL })).json();

  // Stored record carries the metadata derived at store time.
  const rec = JSON.parse(LINKS.store.get(slug));
  assert.equal(rec.url, GRAPH_URL);
  assert.equal(rec.title, "text → llm → image");
  assert.equal(rec.desc, CARD_DESC);

  const res = await call({ LINKS }, `/${slug}`);
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.ok(page.includes('<meta property="og:title" content="text → llm → image">'), "og:title");
  assert.ok(page.includes(`<meta property="og:description" content="${CARD_DESC}">`), "og:description");
  assert.ok(page.includes('<meta property="og:site_name" content="nanoodle">'), "og:site_name");
  assert.ok(page.includes('<meta property="og:type" content="website">'), "og:type");
  assert.ok(page.includes(`<meta property="og:url" content="${BASE}/${slug}">`), "og:url = short link");
  assert.ok(page.includes('<meta property="og:image" content="https://nanoodle.com/og-card.png">'), "og:image");
  assert.ok(page.includes('<meta name="twitter:card" content="summary_large_image">'), "twitter:card");
  // v1 bounce mechanics untouched.
  assert.match(page, /http-equiv="refresh"/);
  assert.match(page, /location\.replace\(/);
});

test("store + bounce an #a=u app link: app name becomes the card title", async () => {
  const LINKS = kvStub();
  const app = { v: 1, graph: GRAPH, name: "Poster maker" };
  const url = "https://nanoodle.com/play#a=u" + b64url(JSON.stringify(app));
  const { slug } = await (await postLink({ LINKS }, { url })).json();
  assert.equal(JSON.parse(LINKS.store.get(slug)).title, "Poster maker");
  const page = await (await call({ LINKS }, `/${slug}`)).text();
  assert.ok(page.includes('<meta property="og:title" content="Poster maker">'));
});

test("LEGACY plain-string KV value still bounces, with the generic card", async () => {
  const LINKS = kvStub();
  const slug = await slugFor(GOOD_URL);
  LINKS.store.set(slug, GOOD_URL); // exactly what v1 stored
  const res = await call({ LINKS }, `/${slug}`);
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.ok(page.includes(GOOD_URL), "still bounces to the stored url");
  assert.ok(page.includes(`<meta property="og:title" content="${GENERIC_TITLE}">`), "generic title");
  assert.ok(page.includes(`<meta property="og:description" content="${CARD_DESC}">`), "brand desc");
  // Peek also reads the legacy shape.
  const peek = await call({ LINKS }, `/api/links/${slug}`);
  assert.deepEqual(await peek.json(), { url: GOOD_URL });
});

test("malformed fragment: POST still 200, bounce serves the generic card", async () => {
  const LINKS = kvStub();
  for (const frag of [
    "#g=!!!not-base64url!!!",
    "#g=" + b64url("not gzip at all"),
    "#a=" + b64url(gzipSync("this is not json")),
    "#j=" + b64url("{truncated"),
    "#a=u" + b64url("[1,2,3]"), // valid JSON, wrong shape
    "#unrelated=stuff",
    "", // no fragment at all
  ]) {
    const url = "https://nanoodle.com/play" + frag;
    const res = await postLink({ LINKS }, { url });
    assert.equal(res.status, 200, frag);
    const { slug } = await res.json();
    const rec = JSON.parse(LINKS.store.get(slug));
    assert.equal(rec.title, null, frag);
    const page = await (await call({ LINKS }, `/${slug}`)).text();
    assert.ok(page.includes(`<meta property="og:title" content="${GENERIC_TITLE}">`), frag);
  }
});

test("XSS attempt in app name / node type renders escaped", async () => {
  const LINKS = kvStub();
  const nasty = '"><script>alert(1)</script>';
  const cases = [
    "https://nanoodle.com/play#a=u" + b64url(JSON.stringify({ v: 1, graph: GRAPH, name: nasty })),
    "https://nanoodle.com/#j=" + b64url(JSON.stringify({
      v: 1,
      nodes: [{ id: "n1", type: nasty, x: 0, y: 0, fields: {} }],
      links: [],
    })),
  ];
  for (const url of cases) {
    const { slug } = await (await postLink({ LINKS }, { url })).json();
    const page = await (await call({ LINKS }, `/${slug}`)).text();
    assert.ok(!page.includes(nasty), "raw payload must not appear");
    assert.ok(page.includes("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"), "escaped form appears");
    // Still exactly the one intentional inline script.
    assert.equal(page.split("<script>").length - 1, 1);
  }
});

// --- v3: uploaded card PNGs ---------------------------------------------------

// Just enough PNG to pass validateCard: signature + IHDR dims.
function pngBytes(w = CARD_WIDTH, h = CARD_HEIGHT) {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, w);
  view.setUint32(20, h);
  return bytes;
}

const CARD_B64 = Buffer.from(pngBytes()).toString("base64");

test("POST with card stores the PNG; bounce + og.png serve it", async () => {
  const LINKS = kvStub();
  const { slug } = await (await postLink({ LINKS }, { url: GRAPH_URL, card: CARD_B64 })).json();

  // Record carries the img flag; the PNG sits under img:<slug>.
  assert.equal(JSON.parse(LINKS.store.get(slug)).img, true);
  assert.ok(LINKS.store.get(cardKey(slug)) instanceof Uint8Array);

  // Bounce page points og:image at the per-slug card, not the shared one.
  const page = await (await call({ LINKS }, `/${slug}`)).text();
  assert.ok(page.includes(`<meta property="og:image" content="${BASE}/${slug}/og.png">`));
  assert.ok(!page.includes("https://nanoodle.com/og-card.png"));

  // The image route serves it immutably.
  const res = await call({ LINKS }, `/${slug}/og.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), pngBytes());
});

test("POST without card keeps the shared brand image", async () => {
  const LINKS = kvStub();
  const { slug } = await (await postLink({ LINKS }, { url: GRAPH_URL })).json();
  assert.equal(JSON.parse(LINKS.store.get(slug)).img, undefined);
  const page = await (await call({ LINKS }, `/${slug}`)).text();
  assert.ok(page.includes('<meta property="og:image" content="https://nanoodle.com/og-card.png">'));
  assert.equal((await call({ LINKS }, `/${slug}/og.png`)).status, 404);
});

test("POST rejects invalid cards without storing anything", async () => {
  const LINKS = kvStub();
  const cases = [
    "!!!not base64!!!",
    Buffer.from(pngBytes(640, 480)).toString("base64"),
    Buffer.from("definitely not a png but long enough to check").toString("base64"),
    42,
  ];
  for (const card of cases) {
    const res = await postLink({ LINKS }, { url: GRAPH_URL, card });
    assert.equal(res.status, 400, String(card).slice(0, 30));
  }
  assert.equal(LINKS.puts, 0);
});

test("card is only honored at slug creation, never attached later", async () => {
  const LINKS = kvStub();
  // Victim creates the link (no card, e.g. an older client).
  const { slug } = await (await postLink({ LINKS }, { url: GRAPH_URL })).json();
  // Attacker re-posts the same public URL with their own image.
  const res = await postLink({ LINKS }, { url: GRAPH_URL, card: CARD_B64 });
  assert.equal(res.status, 200);
  assert.equal(LINKS.store.has(cardKey(slug)), false, "no image stored");
  assert.equal(JSON.parse(LINKS.store.get(slug)).img, undefined, "record unchanged");
  const page = await (await call({ LINKS }, `/${slug}`)).text();
  assert.ok(page.includes("https://nanoodle.com/og-card.png"));
});

test("og.png for unknown or malformed slugs is 404 and never hits KV on junk", async () => {
  const LINKS = kvStub();
  assert.equal((await call({ LINKS }, "/AAAAAAAA/og.png")).status, 404);
  let gets = 0;
  LINKS.get = async () => (gets++, null);
  for (const p of ["/short/og.png", "/way-too-long-slug/og.png", "/AAAA*AAA/og.png"]) {
    assert.equal((await call({ LINKS }, p)).status, 404, p);
  }
  assert.equal(gets, 0);
});


// --- concurrency, failure and recovery --------------------------------------

test("concurrent first creates keep one card even with stale KV misses", async () => {
  const LINKS = kvStub();
  LINKS.get = async () => null; // negative cache at every edge
  const CREATORS = creatorNamespace(LINKS);
  const alternate = pngBytes();
  alternate[40] = 1;
  const responses = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    postLink({ LINKS, CREATORS }, { url: GRAPH_URL,
      card: i ? Buffer.from(alternate).toString("base64") : CARD_B64 })));
  assert.ok(responses.every(r => r.status === 200));
  assert.equal(LINKS.puts, 2, "only one image and record published");
  assert.deepEqual(new Uint8Array(LINKS.store.get(cardKey(await slugFor(GRAPH_URL)))), pngBytes());
});

test("failed record publication recovers original card after eviction", async () => {
  const LINKS = kvStub();
  const put = LINKS.put.bind(LINKS);
  let fail = true;
  LINKS.put = async (key, value) => {
    if (!key.startsWith("img:") && fail) throw new Error("KV unavailable");
    return put(key, value);
  };
  const CREATORS = creatorNamespace(LINKS);
  const env = { LINKS, CREATORS };
  const slug = await slugFor(GRAPH_URL);
  const failed = await postLink(env, { url: GRAPH_URL, card: CARD_B64 });
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get("retry-after"), "5");
  assert.equal(failed.headers.get("access-control-allow-origin"), "https://nanoodle.com");
  assert.equal((await call(env, `/${slug}/og.png`)).status, 404, "orphan is hidden");
  CREATORS.evict(slug);
  fail = false;
  const retried = await postLink(env, { url: GRAPH_URL });
  assert.equal(retried.status, 200);
  assert.equal(JSON.parse(LINKS.store.get(slug)).img, true, "retry cannot remove original card");
  assert.deepEqual(new Uint8Array(await (await call(env, `/${slug}/og.png`)).arrayBuffer()), pngBytes());
});

test("image failure followed by a different card retries the reserved image", async () => {
  const LINKS = kvStub();
  const put = LINKS.put.bind(LINKS);
  let fail = true;
  LINKS.put = async (key, value) => {
    if (fail) throw new Error("storage outage");
    return put(key, value);
  };
  const env = { LINKS, CREATORS: creatorNamespace(LINKS) };
  assert.equal((await postLink(env, { url: GRAPH_URL, card: CARD_B64 })).status, 503);
  fail = false;
  const alternate = pngBytes(); alternate[40] = 1;
  assert.equal((await postLink(env, { url: GRAPH_URL, card: Buffer.from(alternate).toString("base64") })).status, 200);
  assert.deepEqual(new Uint8Array(LINKS.store.get(cardKey(await slugFor(GRAPH_URL)))), pngBytes());
});

test("existing conflicting URL returns 409 without modifying stored link", async () => {
  const LINKS = kvStub();
  const slug = await slugFor(GRAPH_URL);
  const other = "https://nanoodle.com/#other";
  LINKS.store.set(slug, other); // simulate a truncated hash collision
  const res = await postLink({ LINKS }, { url: GRAPH_URL, card: CARD_B64 });
  assert.equal(res.status, 409);
  assert.equal(LINKS.store.get(slug), other);
  assert.equal(LINKS.puts, 0);
});

test("published creation survives stale reads after eviction without new writes", async () => {
  const LINKS = kvStub();
  const CREATORS = creatorNamespace(LINKS);
  const env = { LINKS, CREATORS };
  assert.equal((await postLink(env, { url: GRAPH_URL })).status, 200);
  CREATORS.evict(await slugFor(GRAPH_URL));
  LINKS.get = async () => null;
  assert.equal((await postLink(env, { url: GRAPH_URL, card: CARD_B64 })).status, 200);
  assert.equal(LINKS.puts, 1);
});

test("storage faults and invalid persisted targets fail closed, without caching", async () => {
  const LINKS = kvStub();
  LINKS.get = async () => { throw new Error("private backend details"); };
  for (const path of ["/AAAAAAAA", "/AAAAAAAA/og.png", "/api/links/AAAAAAAA"]) {
    const res = await call({ LINKS }, path);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.ok(!(await res.text()).includes("private backend details"));
  }
  for (const value of ["{broken", '{"url":"javascript:alert(1)"}', "https://evil.example/"]) {
    LINKS.get = async () => value;
    assert.equal((await call({ LINKS }, "/AAAAAAAA")).status, 503);
    assert.equal((await call({ LINKS }, "/api/links/AAAAAAAA")).status, 503);
  }
});

test("missing coordinator fails closed without a KV write", async () => {
  const LINKS = kvStub();
  const res = await worker.fetch(new Request(BASE + "/api/links", {
    method: "POST", body: JSON.stringify({ url: GRAPH_URL }),
  }), { LINKS });
  assert.equal(res.status, 503);
  assert.equal(LINKS.puts, 0);
});

test("oversized streamed JSON is cancelled before any persistence", async () => {
  const LINKS = kvStub();
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(65536)); },
    cancel() { cancelled = true; },
  });
  const response = await call({ LINKS }, "/api/links", { method: "POST", body: stream, duplex: "half" });
  assert.equal(response.status, 413);
  assert.equal(cancelled, true);
  assert.equal(LINKS.puts, 0);
  // A legal worst-case escaped URL fits within the transport ceiling.
  assert.ok(JSON.stringify({ url: "\u0000".repeat(MAX_URL_LENGTH), card: CARD_B64 }).length < MAX_REQUEST_BYTES);
});

test("HEAD has GET status and headers but no response body on all HTML paths", async () => {
  const LINKS = kvStub();
  const { slug } = await (await postLink({ LINKS }, { url: GRAPH_URL, card: CARD_B64 })).json();
  for (const path of ["/", `/${slug}`, `/${slug}/og.png`, "/AAAAAAAA"]) {
    const res = await call({ LINKS }, path, { method: "HEAD" });
    assert.equal(await res.text(), "");
    assert.equal(res.status, path === "/AAAAAAAA" ? 404 : 200);
    assert.ok(res.headers.get("content-type"));
  }
});
