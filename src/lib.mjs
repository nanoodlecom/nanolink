// Pure logic for the nanolink worker: validation, slugs, escaping, and HTML
// pages. No I/O, no state — everything here runs unmodified in plain Node
// (>= 20, where crypto.subtle and btoa are globals) and in Cloudflare Workers.

/** Hard ceiling on stored URL length (128 KiB). */
export const MAX_URL_LENGTH = 131072;

/** Slugs are the first 8 chars of base64url(SHA-256(url)). */
export const SLUG_LENGTH = 8;

/** What a valid slug looks like (base64url alphabet, fixed length). */
export const SLUG_RE = /^[A-Za-z0-9_-]{8}$/;

/** Only these exact origins may be shortened. */
export const ALLOWED_ORIGINS = Object.freeze([
  "https://nanoodle.com",
  "https://www.nanoodle.com",
]);

/**
 * Decide whether `url` is allowed as a shorten target.
 * Parses with `new URL` and compares origin + protocol exactly — a prefix
 * check would wave through "https://nanoodle.com.evil.tld/…" or
 * "https://nanoodle.com@evil.tld/…"; this does not.
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function validateTarget(url) {
  if (typeof url !== "string") {
    return { ok: false, reason: "url must be a string" };
  }
  if (url.length > MAX_URL_LENGTH) {
    return { ok: false, reason: `url must be at most ${MAX_URL_LENGTH} characters` };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "url must be a valid absolute URL" };
  }
  if (parsed.protocol !== "https:" || !ALLOWED_ORIGINS.includes(parsed.origin)) {
    return { ok: false, reason: "url must be on https://nanoodle.com" };
  }
  return { ok: true };
}

/**
 * Deterministic slug: first 8 chars of base64url(SHA-256(url)).
 * Same URL → same slug, always — so re-shortening a link never stores a
 * second copy and never mints a second short URL.
 */
export async function slugFor(url) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  const bytes = new Uint8Array(digest);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64url = btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return b64url.slice(0, SLUG_LENGTH);
}

/** Escape a string for HTML text and attribute contexts. */
export function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

/**
 * Escape a string for embedding inside a JS string literal in an inline
 * <script>. Uses uniform \uXXXX escapes so quotes, backslashes, `</script>`
 * sequences, and the U+2028/U+2029 line terminators are all inert.
 */
export function escapeJsString(s) {
  return s.replace(/[\\'"<>\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

const PAGE_CSS = `
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 16px/1.5 system-ui, sans-serif;
    background: #fafafa; color: #1a1a1a;
  }
  main { max-width: 34rem; padding: 2rem; text-align: center; }
  a.go {
    display: inline-block; margin: 1rem 0; padding: 0.6rem 1.2rem;
    border-radius: 0.5rem; text-decoration: none; font-weight: 600;
    background: #1a1a1a; color: #fafafa;
  }
  p.about { font-size: 0.85rem; opacity: 0.7; }
  @media (prefers-color-scheme: dark) {
    body { background: #111; color: #eee; }
    a.go { background: #eee; color: #111; }
  }
`.replace(/\s+/g, " ").trim();

/**
 * The body-bounce page for GET /<slug>. The long URL travels in the response
 * BODY (meta refresh + JS location.replace + a visible fallback link), never
 * in a Location header — Cloudflare's h3 edge stalls on response headers over
 * ~10KB, and nanoodle share links can be 10–60KB.
 *
 * `url` is validated same-origin before it is ever stored, but it is
 * HTML-escaped in attributes and \uXXXX-escaped in the script anyway.
 */
export function bouncePage(url) {
  const attr = escapeHtml(url);
  const js = escapeJsString(url);
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0;url=${attr}">
<title>nanolink → nanoodle</title>
<style>${PAGE_CSS}</style>
<script>location.replace("${js}");</script>
<main>
  <h1>Opening your noodle…</h1>
  <a class="go" href="${attr}">Continue to nanoodle &rarr;</a>
  <p class="about">nanolink is nanoodle&#39;s own link shortener — the whole
  workflow travels inside the link itself, and nothing is logged.</p>
</main>
</html>
`;
}

/** 404 page for unknown slugs. */
export function notFoundPage() {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>nanolink — not found</title>
<style>${PAGE_CSS}</style>
<main>
  <h1>Link not found</h1>
  <p>This short link doesn&#39;t exist (or was mistyped).</p>
  <a class="go" href="https://nanoodle.com/">Go to nanoodle &rarr;</a>
</main>
</html>
`;
}

/** Minimal landing page for GET /. */
export function homePage() {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>nanolink</title>
<style>${PAGE_CSS}</style>
<main>
  <h1>nanolink</h1>
  <p>First-party link shortener for <a href="https://nanoodle.com/">nanoodle</a>
  share links. No analytics, no logs, no cookies.</p>
</main>
</html>
`;
}
