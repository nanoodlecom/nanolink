import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import {
  MAX_URL_LENGTH,
  SLUG_LENGTH,
  SLUG_RE,
  MAX_TITLE_LENGTH,
  CARD_DESC,
  GENERIC_TITLE,
  CARD_IMAGE,
  CARD_WIDTH,
  CARD_HEIGHT,
  MAX_CARD_BYTES,
  cardKey,
  validateCard,
  validateTarget,
  slugFor,
  escapeHtml,
  escapeJsString,
  b64urlToBytes,
  gunzip,
  graphChainTitle,
  deriveCardMeta,
  packRecord,
  parseRecord,
  bouncePage,
  notFoundPage,
  homePage,
} from "../src/lib.mjs";

// --- validateTarget -------------------------------------------------------

test("accepts nanoodle.com and www.nanoodle.com https urls", () => {
  assert.equal(validateTarget("https://nanoodle.com/").ok, true);
  assert.equal(validateTarget("https://nanoodle.com/play#a=abc123").ok, true);
  assert.equal(validateTarget("https://www.nanoodle.com/?x=1#frag").ok, true);
});

test("accepts a url right at the length ceiling", () => {
  const base = "https://nanoodle.com/#a=";
  const url = base + "x".repeat(MAX_URL_LENGTH - base.length);
  assert.equal(url.length, MAX_URL_LENGTH);
  assert.equal(validateTarget(url).ok, true);
});

test("rejects non-strings", () => {
  for (const bad of [undefined, null, 42, {}, ["https://nanoodle.com/"], true]) {
    const v = validateTarget(bad);
    assert.equal(v.ok, false);
    assert.match(v.reason, /string/);
  }
});

test("rejects over-length urls before parsing", () => {
  const url = "https://nanoodle.com/#" + "x".repeat(MAX_URL_LENGTH);
  const v = validateTarget(url);
  assert.equal(v.ok, false);
  assert.match(v.reason, /131072/);
});

test("rejects unparseable urls", () => {
  for (const bad of ["", "nanoodle.com/play", "/play", "https://", "ht!tp://x"]) {
    assert.equal(validateTarget(bad).ok, false, JSON.stringify(bad));
  }
});

test("rejects wrong protocol", () => {
  assert.equal(validateTarget("http://nanoodle.com/").ok, false);
  assert.equal(validateTarget("javascript:alert(1)").ok, false);
  assert.equal(validateTarget("ftp://nanoodle.com/").ok, false);
});

test("rejects lookalike hosts that defeat prefix-string checks", () => {
  for (const bad of [
    "https://nanoodle.com.evil.tld/play",       // suffix trick
    "https://nanoodle.com@evil.tld/play",       // userinfo trick
    "https://nanoodle.com.evil.tld/https://nanoodle.com/",
    "https://evil.tld/https://nanoodle.com/",
    "https://xn--nanoodle-com.evil.tld/",
    "https://nanoodlexcom/",
    "https://sub.nanoodle.com/",                // only apex + www allowed
    "https://nanoodle.com:8443/",               // non-default port = different origin
  ]) {
    assert.equal(validateTarget(bad).ok, false, bad);
  }
});

// --- slugFor ---------------------------------------------------------------

test("slug is deterministic, 8 chars, base64url alphabet", async () => {
  const a = await slugFor("https://nanoodle.com/play#a=hello");
  const b = await slugFor("https://nanoodle.com/play#a=hello");
  const c = await slugFor("https://nanoodle.com/play#a=hellO");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, SLUG_LENGTH);
  assert.match(a, SLUG_RE);
  assert.match(c, SLUG_RE);
});

test("slug matches an independent SHA-256/base64url computation", async () => {
  const url = "https://nanoodle.com/play#a=check";
  const { createHash } = await import("node:crypto");
  const expected = createHash("sha256").update(url).digest("base64url").slice(0, 8);
  assert.equal(await slugFor(url), expected);
});

// --- escaping ---------------------------------------------------------------

test("escapeHtml neutralizes markup-significant characters", () => {
  assert.equal(
    escapeHtml(`<img src=x onerror="pwn('&')">`),
    "&lt;img src=x onerror=&quot;pwn(&#39;&amp;&#39;)&quot;&gt;",
  );
  assert.equal(escapeHtml("plain-safe_~!@#$%"), "plain-safe_~!@#$%");
});

test("escapeJsString neutralizes quotes, backslashes, tags, LS/PS", () => {
  const out = escapeJsString(`"'\\</script>  `);
  assert.equal(out, "\\u0022\\u0027\\u005c\\u003c/script\\u003e\\u2028\\u2029");
  // Round-trip: escaping then evaluating as a JS string yields the original.
  const nasty = `a"b'c\\d</script>e f`;
  assert.equal(new Function(`return "${escapeJsString(nasty)}";`)(), nasty);
});

// --- pages -------------------------------------------------------------------

test("bouncePage carries the url in body: meta refresh + script + anchor", () => {
  const url = "https://nanoodle.com/play#a=abc&b=1";
  const page = bouncePage(url);
  assert.match(page, /<meta name="robots" content="noindex">/);
  assert.ok(page.includes(`content="0;url=${escapeHtml(url)}"`), "meta refresh");
  assert.ok(page.includes(`location.replace("${escapeJsString(url)}");`), "script");
  assert.ok(page.includes(`href="${escapeHtml(url)}"`), "visible anchor");
  assert.match(page, /Continue to nanoodle/);
  assert.match(page, /prefers-color-scheme: dark/);
});

test("bouncePage never embeds a hostile url unescaped", () => {
  // Not producible via the API (validation would reject it), but the page
  // must be safe even if such a value ever reached it.
  const nasty = "https://nanoodle.com/\"><script>alert(1)</script>#'\u2028";
  const page = bouncePage(nasty);
  assert.ok(!page.includes('"><script>alert(1)</script>'));
  // Exactly the one intentional inline script...
  assert.equal(page.split("<script>").length - 1, 1);
  // ...and its JS string literal carries no raw quote, angle bracket, LS/PS,
  // or any backslash that is not part of a \uXXXX escape.
  const script = page.match(/<script>([^]*?)<\/script>/)[1];
  const inner = script.match(/^location\.replace\("(.*)"\);$/)[1];
  assert.doesNotMatch(inner, /["'<>\u2028\u2029]/);
  assert.doesNotMatch(inner, /\\(?!u[0-9a-f]{4})/);
});

test("notFoundPage and homePage render", () => {
  assert.match(notFoundPage(), /Link not found/);
  assert.match(homePage(), /nanolink/);
  assert.match(homePage(), /No analytics, no logs, no cookies/);
});

// --- card metadata (v2) --------------------------------------------------------

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

const GRAPH = {
  v: 1,
  nodes: [
    { id: "n1", type: "text" },
    { id: "n2", type: "llm" },
    { id: "n3", type: "image" },
  ],
  links: [
    { id: "l1", from: { node: "n1", port: "text" }, to: { node: "n2", port: "prompt" } },
    { id: "l2", from: { node: "n2", port: "text" }, to: { node: "n3", port: "prompt" } },
  ],
};

test("b64urlToBytes round-trips base64url with -/_ and no padding", () => {
  const bytes = new Uint8Array([0, 251, 255, 62, 63, 1]);
  assert.deepEqual(b64urlToBytes(Buffer.from(bytes).toString("base64url")), bytes);
});

test("gunzip inflates gzipSync output and enforces the size ceiling", async () => {
  assert.equal(await gunzip(gzipSync("hello nanolink")), "hello nanolink");
  const bomb = gzipSync(Buffer.alloc(1024 * 1024)); // 1 MiB of zeros, ~1 KiB gzipped
  await assert.rejects(() => gunzip(bomb, 1024), /too large/);
});

test("graphChainTitle follows links from source nodes", () => {
  assert.equal(graphChainTitle(GRAPH), "text → llm → image");
  // Declaration order is NOT wire order — topology wins.
  const shuffled = { nodes: [...GRAPH.nodes].reverse(), links: GRAPH.links };
  assert.equal(graphChainTitle(shuffled), "text → llm → image");
});

test("graphChainTitle survives cycles, dangling links, junk nodes", () => {
  const cyclic = {
    nodes: [{ id: "a", type: "llm" }, { id: "b", type: "image" }],
    links: [
      { from: { node: "a", port: "x" }, to: { node: "b", port: "y" } },
      { from: { node: "b", port: "x" }, to: { node: "a", port: "y" } },
      { from: { node: "ghost", port: "x" }, to: { node: "a", port: "y" } },
    ],
  };
  assert.equal(cyclic.nodes.length, graphChainTitle(cyclic).split(" → ").length);
  assert.equal(graphChainTitle({ nodes: [], links: [] }), null);
  assert.equal(graphChainTitle({ nodes: [{ id: "n1" }, null, 42] }), null);
  assert.equal(graphChainTitle(null), null);
});

test("titles are capped at 70 chars", async () => {
  const many = {
    nodes: Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, type: "translate" })),
    links: [],
  };
  const title = graphChainTitle(many);
  assert.equal(title.length, MAX_TITLE_LENGTH);
  assert.ok(title.endsWith("…"));
  const app = { v: 1, graph: GRAPH, name: "x".repeat(200) };
  const url = "https://nanoodle.com/play#a=u" + b64url(JSON.stringify(app));
  const meta = await deriveCardMeta(url);
  assert.equal(meta.title.length, MAX_TITLE_LENGTH);
});

test("deriveCardMeta decodes all four fragment formats", async () => {
  const graphJson = JSON.stringify(GRAPH);
  const appJson = JSON.stringify({ v: 1, graph: GRAPH, name: "Ramen namer" });
  const cases = [
    ["https://nanoodle.com/#g=" + b64url(gzipSync(graphJson)), "text → llm → image"],
    ["https://nanoodle.com/#j=" + b64url(graphJson), "text → llm → image"],
    ["https://nanoodle.com/play#a=" + b64url(gzipSync(appJson)), "Ramen namer"],
    ["https://nanoodle.com/play#a=u" + b64url(appJson), "Ramen namer"],
  ];
  for (const [url, title] of cases) {
    assert.deepEqual(await deriveCardMeta(url), { title, desc: CARD_DESC }, url.slice(0, 40));
  }
});

test("deriveCardMeta app fallbacks: files title, then graph chain", async () => {
  const withFiles = {
    v: 1,
    graph: GRAPH,
    files: { "index.html": "<html><title>Neon poster</title></html>" },
  };
  const a = await deriveCardMeta(
    "https://nanoodle.com/play#a=u" + b64url(JSON.stringify(withFiles)),
  );
  assert.equal(a.title, "Neon poster");
  const bare = { v: 1, graph: GRAPH };
  const b = await deriveCardMeta(
    "https://nanoodle.com/play#a=u" + b64url(JSON.stringify(bare)),
  );
  assert.equal(b.title, "text → llm → image");
});

test("deriveCardMeta returns null on anything undecodable — never throws", async () => {
  for (const url of [
    "https://nanoodle.com/",
    "https://nanoodle.com/#g=%%%",
    "https://nanoodle.com/#g=" + b64url("not gzip"),
    "https://nanoodle.com/#j=" + b64url("{nope"),
    "https://nanoodle.com/#a=u" + b64url('"just a string"'),
    "https://nanoodle.com/#other=thing",
    "not even a url",
  ]) {
    assert.equal(await deriveCardMeta(url), null, url.slice(0, 50));
  }
});

// --- KV record shape (v2 + legacy) -----------------------------------------------

test("packRecord/parseRecord round-trip, with and without metadata", () => {
  const url = "https://nanoodle.com/play#a=xyz";
  const meta = { title: "Ramen namer", desc: CARD_DESC };
  assert.deepEqual(parseRecord(packRecord(url, meta)), { url, ...meta, img: false });
  assert.deepEqual(parseRecord(packRecord(url, null)), { url, title: null, desc: null, img: false });
  assert.deepEqual(parseRecord(packRecord(url, meta, true)), { url, ...meta, img: true });
  // v2 records (no img key) parse as img: false.
  assert.equal(parseRecord(JSON.stringify({ url, title: null, desc: null })).img, false);
});

test("parseRecord handles legacy v1 plain-string values", () => {
  const url = "https://nanoodle.com/play#g=abc";
  assert.deepEqual(parseRecord(url), { url, title: null, desc: null, img: false });
  // Even a pathological "{" prefix that isn't valid JSON falls back safely.
  assert.deepEqual(parseRecord("{not json"), { url: "{not json", title: null, desc: null, img: false });
});

// --- bouncePage OG tags -----------------------------------------------------------

test("bouncePage emits the full OG/Twitter card", () => {
  const url = "https://nanoodle.com/play#a=abc";
  const page = bouncePage(url, {
    shortUrl: "https://nnoodl.example/Qm3xY9_k",
    title: "Ramen namer",
    desc: CARD_DESC,
  });
  assert.ok(page.includes('<meta property="og:site_name" content="nanoodle">'));
  assert.ok(page.includes('<meta property="og:type" content="website">'));
  assert.ok(page.includes('<meta property="og:title" content="Ramen namer">'));
  assert.ok(page.includes(`<meta property="og:description" content="${CARD_DESC}">`));
  assert.ok(page.includes('<meta property="og:url" content="https://nnoodl.example/Qm3xY9_k">'));
  assert.ok(page.includes(`<meta property="og:image" content="${CARD_IMAGE}">`));
  assert.ok(page.includes('<meta name="twitter:card" content="summary_large_image">'));
  assert.match(page, /<title>Ramen namer · nanoodle<\/title>/);
});

test("bouncePage without card metadata serves the generic card (v1-compatible)", () => {
  const page = bouncePage("https://nanoodle.com/play#a=abc");
  assert.ok(page.includes(`<meta property="og:title" content="${GENERIC_TITLE}">`));
  assert.ok(page.includes(`<meta property="og:description" content="${CARD_DESC}">`));
  assert.ok(!page.includes('property="og:url"'), "no og:url without a shortUrl");
});

test("bouncePage escapes hostile card metadata", () => {
  const nasty = '"><script>alert(1)</script>';
  const page = bouncePage("https://nanoodle.com/", {
    shortUrl: "https://nnoodl.example/x",
    title: nasty,
    desc: nasty,
  });
  assert.ok(!page.includes(nasty));
  assert.ok(page.includes("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.equal(page.split("<script>").length - 1, 1);
});

// --- v3: uploaded card PNGs -------------------------------------------------------

// Just enough PNG for validateCard: signature + IHDR length/type/dims.
function pngBytes(w = CARD_WIDTH, h = CARD_HEIGHT) {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); // IHDR data length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, w);
  view.setUint32(20, h);
  return bytes;
}

test("validateCard accepts a 1200×630 PNG and returns its bytes", () => {
  const bytes = pngBytes();
  const verdict = validateCard(Buffer.from(bytes).toString("base64"));
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.bytes, bytes);
});

test("validateCard rejects non-strings, bad base64, non-PNGs, wrong dims, oversize", () => {
  const cases = [
    [42, "non-string"],
    [null, "null"],
    ["!!!not base64!!!", "bad base64"],
    [Buffer.from("GIF89a not a png at all, needs 33+ bytes!").toString("base64"), "not a PNG"],
    [Buffer.from(pngBytes().slice(0, 20)).toString("base64"), "truncated"],
    [Buffer.from(pngBytes(800, 418)).toString("base64"), "wrong dims"],
    [Buffer.from(pngBytes(CARD_WIDTH, CARD_HEIGHT + 1)).toString("base64"), "off-by-one height"],
    ["A".repeat(Math.ceil(MAX_CARD_BYTES / 3) * 4 + 8), "encoded length over ceiling"],
  ];
  for (const [input, label] of cases) {
    assert.equal(validateCard(input).ok, false, label);
  }
  // Exactly at the byte ceiling but not a PNG: rejected for content, and a
  // real PNG padded past the ceiling is rejected for size.
  const big = new Uint8Array(MAX_CARD_BYTES + 1);
  big.set(pngBytes());
  assert.match(validateCard(Buffer.from(big).toString("base64")).reason, /at most/);
});

test("cardKey namespaces outside the slug alphabet", () => {
  assert.equal(cardKey("AAAAAAAA"), "img:AAAAAAAA");
  assert.ok(!SLUG_RE.test(cardKey("AAAAAAAA")));
});

test("bouncePage points og:image at the per-slug card when given one", () => {
  const image = "https://nnoodl.example/Qm3xY9_k/og.png";
  const page = bouncePage("https://nanoodle.com/play#a=abc", { image });
  assert.ok(page.includes(`<meta property="og:image" content="${image}">`));
  assert.ok(!page.includes(CARD_IMAGE));
});
