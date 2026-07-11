import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.mjs";
import { slugFor, MAX_URL_LENGTH } from "../src/lib.mjs";

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
  assert.equal(LINKS.store.get(body.slug), GOOD_URL);
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
