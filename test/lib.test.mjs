import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_URL_LENGTH,
  SLUG_LENGTH,
  SLUG_RE,
  validateTarget,
  slugFor,
  escapeHtml,
  escapeJsString,
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
