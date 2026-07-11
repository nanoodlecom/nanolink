// nanolink — first-party, zero-analytics link shortener for nanoodle share
// links. Cloudflare Worker + KV (binding: LINKS).
//
// Routes:
//   POST /api/links            {url} -> {slug, shortUrl}
//   GET  /api/links/<slug>     -> {url}                     (peek)
//   GET  /<slug>               -> 200 HTML body-bounce page (with OG card)
//   GET  /                     -> tiny landing page
//
// No logging, no analytics, no cookies — nothing beyond the slug -> record
// pair is ever stored, and nothing at all is recorded when a link is
// followed. The record is {url, title, desc}: card metadata is derived once,
// at store time, from the workflow already encoded in the URL fragment —
// no extra data collected. v1 stored the bare URL string; reads accept both.

import {
  validateTarget,
  slugFor,
  deriveCardMeta,
  packRecord,
  parseRecord,
  bouncePage,
  notFoundPage,
  homePage,
  SLUG_RE,
} from "./lib.mjs";

/** The only origin allowed to call the JSON API from a browser. */
const ALLOW_ORIGIN = "https://nanoodle.com";

const CORS_HEADERS = {
  "access-control-allow-origin": ALLOW_ORIGIN,
  "vary": "Origin",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...CORS_HEADERS,
    },
  });
}

function html(body, status, cacheControl) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "cache-control": cacheControl,
      "x-robots-tag": "noindex",
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight for the JSON API.
    if (request.method === "OPTIONS" && path.startsWith("/api/")) {
      return new Response(null, {
        status: 204,
        headers: {
          ...CORS_HEADERS,
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "86400",
        },
      });
    }

    // POST /api/links — create (or find) a short link.
    if (path === "/api/links") {
      if (request.method !== "POST") {
        return json({ error: "method not allowed" }, 405);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "body must be JSON" }, 400);
      }
      const verdict = validateTarget(body?.url);
      if (!verdict.ok) {
        return json({ error: verdict.reason }, 400);
      }
      const slug = await slugFor(body.url);
      // Deterministic slug: same url -> same slug, so only store once.
      // (A concurrent duplicate put is harmless — it writes the same value.)
      const existing = await env.LINKS.get(slug);
      if (existing === null) {
        // Best-effort card metadata from the URL fragment. deriveCardMeta
        // never throws — a malformed fragment stores null metadata and the
        // bounce page serves the generic card.
        const meta = await deriveCardMeta(body.url);
        await env.LINKS.put(slug, packRecord(body.url, meta));
      }
      return json({ slug, shortUrl: `${url.origin}/${slug}` });
    }

    // GET /api/links/<slug> — peek at the stored url.
    const peek = path.match(/^\/api\/links\/([^/]+)$/);
    if (peek) {
      if (request.method !== "GET") {
        return json({ error: "method not allowed" }, 405);
      }
      const raw = SLUG_RE.test(peek[1]) ? await env.LINKS.get(peek[1]) : null;
      if (raw === null) {
        return json({ error: "not found" }, 404);
      }
      return json({ url: parseRecord(raw).url });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "method not allowed" }, 405);
    }

    if (path === "/") {
      return html(homePage(), 200, "public, max-age=3600");
    }

    // GET /<slug> — the body bounce. The long URL travels in the response
    // body, never in a Location header (Cloudflare's h3 edge stalls on
    // response headers over ~10KB; nanoodle share links can be 10–60KB).
    const seg = path.slice(1);
    if (SLUG_RE.test(seg)) {
      const raw = await env.LINKS.get(seg);
      if (raw !== null) {
        // parseRecord handles both the v2 {url, title, desc} record and
        // legacy v1 values (the bare URL string).
        const rec = parseRecord(raw);
        // Slug content is immutable by construction (slug = hash of url),
        // so the page can be cached forever.
        return html(
          bouncePage(rec.url, { shortUrl: `${url.origin}/${seg}`, title: rec.title, desc: rec.desc }),
          200,
          "public, max-age=31536000, immutable",
        );
      }
    }
    return html(notFoundPage(), 404, "no-store");
  },
};
