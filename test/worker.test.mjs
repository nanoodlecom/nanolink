import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import worker from "../src/worker.mjs";
import { slugFor, MAX_URL_LENGTH, CARD_DESC, GENERIC_TITLE } from "../src/lib.mjs";

// Minimal in-memory stand-in for a Workers KV namespace (the two methods the
// worker uses). Counts puts so dedupe behavior is observable.
function kvStub() {
  const store = new Map();
  return {
    store,
    puts: 0,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      this.puts += 1;
      store.set(key, value);
    },
  };
}

const BASE = "https://nanolink.example";

function call(env, path, init) {
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

  const page = await res.text();
  assert.ok(page.includes(GOOD_URL)); // GOOD_URL has no HTML-special chars
  assert.match(page, /http-equiv="refresh"/);
  assert.match(page, /location\.replace\(/);
  assert.match(page, /Continue to nanoodle/);
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
