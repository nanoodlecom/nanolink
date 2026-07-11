// Pure logic for the nanolink worker: validation, slugs, escaping, card
// metadata, and HTML pages. No I/O, no state — everything here runs
// unmodified in plain Node (>= 20, where crypto.subtle, atob, and
// DecompressionStream are globals) and in Cloudflare Workers.

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

// --- link-preview card metadata ---------------------------------------------
//
// nanoodle share links carry the whole workflow in the URL fragment:
//   #g=  base64url(gzip(graph JSON))      #j=  base64url(graph JSON)
//   #a=  base64url(gzip(app JSON))        #a=u base64url(app JSON)
// At store time we best-effort decode that fragment to derive a human title
// for Open Graph / Twitter cards. Every failure path returns null — a
// malformed fragment must never break link creation, it just gets the
// generic card.

/** Fixed brand line used as og:description on every card. */
export const CARD_DESC =
  "A visual AI workflow — opens in your browser, runs on your own NanoGPT key. Nothing is uploaded.";

/** og:title when the fragment can't be decoded (or there is none). */
export const GENERIC_TITLE = "A nanoodle workflow";

/** nanoodle.com's social card image (1200×630 — large-format). */
export const CARD_IMAGE = "https://nanoodle.com/og-card.png";

/** Longest og:title we emit. */
export const MAX_TITLE_LENGTH = 70;

/** Decompressed-size ceiling for gunzip — a stored URL is ≤128 KiB, but a
 *  crafted gzip bomb inside it could expand far beyond that. */
const MAX_INFLATED_BYTES = 4 * 1024 * 1024;

/** base64url → bytes (mirror of the nanoodle editor's b64urlToBytes). */
export function b64urlToBytes(s) {
  s = s.replaceAll("-", "+").replaceAll("_", "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * gunzip → string via DecompressionStream (a global in Workers and Node ≥ 18).
 * Reads incrementally and throws past `maxBytes` so a gzip bomb can't balloon
 * worker memory.
 */
export async function gunzip(bytes, maxBytes = MAX_INFLATED_BYTES) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("decompressed payload too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(out);
}

function capTitle(s) {
  s = s.trim().replace(/\s+/g, " ");
  if (!s) return null;
  return s.length > MAX_TITLE_LENGTH ? s.slice(0, MAX_TITLE_LENGTH - 1) + "…" : s;
}

/**
 * "text → llm → image" from a graph's node types, in topological-ish order
 * (Kahn over links, source nodes first; nodes in cycles or with dangling
 * links are appended in declaration order). Simple and safe beats perfect —
 * this is a card title, not an execution plan. Returns null for no nodes.
 */
export function graphChainTitle(graph) {
  const nodes = (Array.isArray(graph?.nodes) ? graph.nodes : [])
    .filter((n) => n && typeof n.id === "string" && typeof n.type === "string");
  if (!nodes.length) return null;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  const outs = new Map(nodes.map((n) => [n.id, []]));
  for (const l of Array.isArray(graph.links) ? graph.links : []) {
    const from = l?.from?.node, to = l?.to?.node;
    if (!byId.has(from) || !byId.has(to)) continue;
    indeg.set(to, indeg.get(to) + 1);
    outs.get(from).push(to);
  }
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const seen = new Set();
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const to of outs.get(id)) {
      indeg.set(to, indeg.get(to) - 1);
      if (indeg.get(to) <= 0) queue.push(to);
    }
  }
  for (const n of nodes) if (!seen.has(n.id)) order.push(n.id); // cycle leftovers
  return capTitle(order.map((id) => byId.get(id).type).join(" → "));
}

/** Title for an #a= app payload: its `name` field (files-less shares carry
 *  the app title there), else the <title> of the packed index.html, else the
 *  node-type chain of its graph. */
function appTitle(app) {
  if (typeof app?.name === "string") {
    const t = capTitle(app.name);
    if (t) return t;
  }
  const html = app?.files?.["index.html"];
  if (typeof html === "string") {
    const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const t = m && capTitle(m[1]);
    if (t) return t;
  }
  return graphChainTitle(app?.graph);
}

/**
 * Best-effort card metadata for a nanoodle share URL.
 * Returns {title, desc} or null (→ generic card). NEVER throws: any
 * malformed, truncated, oversized, or hostile fragment resolves to null.
 */
export async function deriveCardMeta(url) {
  try {
    const hash = new URL(url).hash;
    let title = null;
    let m;
    if ((m = hash.match(/^#([gj])=(.+)$/))) {
      // #g= gzip / #j= plain graph JSON
      const bytes = b64urlToBytes(m[2]);
      const json = m[1] === "g" ? await gunzip(bytes) : new TextDecoder().decode(bytes);
      title = graphChainTitle(JSON.parse(json));
    } else if ((m = hash.match(/^#a=(u?)(.+)$/))) {
      // #a= gzip / #a=u plain app JSON
      const bytes = b64urlToBytes(m[2]);
      const json = m[1] ? new TextDecoder().decode(bytes) : await gunzip(bytes);
      title = appTitle(JSON.parse(json));
    }
    return title ? { title, desc: CARD_DESC } : null;
  } catch {
    return null;
  }
}

// --- KV record shape ----------------------------------------------------------
//
// v2 stores a JSON object per slug; v1 stored the bare URL string. Reads
// accept both forever — existing links keep working.

/** Serialize a record for KV. */
export function packRecord(url, meta) {
  return JSON.stringify({ url, title: meta?.title ?? null, desc: meta?.desc ?? null });
}

/**
 * Parse a KV value into {url, title, desc}. Handles the v2 JSON shape and
 * legacy v1 values, which were the plain URL string (always "https://…",
 * never "{…", so the two are unambiguous).
 */
export function parseRecord(raw) {
  if (typeof raw === "string" && raw.startsWith("{")) {
    try {
      const rec = JSON.parse(raw);
      if (rec && typeof rec.url === "string") {
        return {
          url: rec.url,
          title: typeof rec.title === "string" ? rec.title : null,
          desc: typeof rec.desc === "string" ? rec.desc : null,
        };
      }
    } catch { /* fall through to legacy */ }
  }
  return { url: raw, title: null, desc: null };
}

/**
 * The one intentional inline script on the bounce page. Factored out so the
 * worker can compute a CSP sha256 hash over the *exact* source that
 * bouncePage emits — the hash allowlists this script and nothing else, so
 * even a hypothetical escaping bug could not execute injected script.
 */
export function bounceScript(url) {
  return `location.replace("${escapeJsString(url)}");`;
}

/**
 * CSP source expression ('sha256-…', standard base64) for an inline script.
 */
export async function inlineScriptHash(source) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  let bin = "";
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return `'sha256-${btoa(bin)}'`;
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
 *
 * `card` (all optional) drives the Open Graph / Twitter tags so the short
 * link renders a rich preview on X/Reddit/Discord/Slack:
 *   {shortUrl, title, desc} — title/desc derive from user-supplied graph
 * JSON, so both are HTML-escaped here; missing pieces fall back to the
 * generic card.
 */
export function bouncePage(url, card = {}) {
  const attr = escapeHtml(url);
  const title = escapeHtml(card.title || GENERIC_TITLE);
  const desc = escapeHtml(card.desc || CARD_DESC);
  const ogUrl = card.shortUrl ? `\n<meta property="og:url" content="${escapeHtml(card.shortUrl)}">` : "";
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0;url=${attr}">
<title>${title} · nanoodle</title>
<meta property="og:site_name" content="nanoodle">
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">${ogUrl}
<meta property="og:image" content="${CARD_IMAGE}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<style>${PAGE_CSS}</style>
<script>${bounceScript(url)}</script>
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
