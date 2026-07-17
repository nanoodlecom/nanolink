# nanolink

**First-party link shortener for [nanoodle](https://nanoodle.com) share
links.** A tiny Cloudflare Worker + KV that turns a 10–60KB share URL into
`https://<your-worker>/<8-char-slug>` — with no analytics, no logs, and no
third party ever seeing the workflow.

Zero dependencies. One worker file, one KV namespace.

This is self-hostable infrastructure, not a hosted service. The nanoodle
editor and app player now call this API for their Share → Shorten button
(see *Integrating with nanoodle*), expecting the canonical instance at
**`https://link.nanoodle.com`** — and degrading gracefully to the full-length
link until that host is deployed. Deploy your own with the quickstart below.

## Why this exists

nanoodle share links carry the **whole workflow in the URL fragment** and can
be 10–60KB long. Third-party shorteners like da.gd return the long URL as a
`Location` response header — and Cloudflare's h3 edge stalls on response
headers over ~10KB, so the redirect hangs forever.

nanolink sidesteps the header entirely. `GET /<slug>` returns a **200 HTML
"body bounce"**: the long URL travels in the response *body* — a meta refresh,
a JS `location.replace(...)`, and a visible fallback link — which has no such
size limit. Being first-party also means no shortener service ever sees the
workflow encoded in the link.

## API

### `GET /`

A tiny static landing page (`200 text/html`, cached for an hour) naming the
service and linking to nanoodle.com — no script, nothing dynamic.

### `POST /api/links`

```
POST /api/links
Content-Type: application/json

{"url": "https://nanoodle.com/play#a=..."}
```

Response:

```json
{"slug": "Qm3xY9_k", "shortUrl": "https://<worker-host>/Qm3xY9_k"}
```

Rules:

- `url` must be a string, at most **131072** characters, and parse (via
  `new URL`) to origin `https://nanoodle.com` or `https://www.nanoodle.com`
  exactly. Origin comparison, not prefix matching —
  `https://nanoodle.com.evil.tld/...` is rejected.
- The slug is the first 8 chars of `base64url(SHA-256(url))`. **Deterministic**:
  the same link always yields the same slug, and is only stored once.
- The KV value is a JSON record `{"url", "title", "desc"}` — `title`/`desc`
  are card metadata best-effort derived from the workflow already encoded in
  the URL fragment (see *Rich link previews*), or `null` when the fragment
  can't be decoded. Values written by v1 were the bare URL string; reads
  accept both shapes forever, so existing links keep working unchanged.
- Errors return `4xx` with `{"error": "..."}`.
- CORS: browser calls are allowed from `https://nanoodle.com` only
  (`OPTIONS` preflight handled).

### `GET /<slug>`

Returns the body-bounce page (`200 text/html`): `<meta http-equiv="refresh">`,
inline `location.replace(...)`, and a visible "Continue to nanoodle →" link.
Sent with `Referrer-Policy: no-referrer`, `noindex`,
`X-Content-Type-Options: nosniff`, and
`Cache-Control: public, max-age=31536000, immutable` — safe because a slug's
content is immutable by construction (it *is* the hash of the URL). Every HTML
response also carries a `Content-Security-Policy` of `default-src 'none'`;
the bounce page's single inline script is allowlisted by the sha256 hash of
its exact emitted source (not `'unsafe-inline'`), so even a hypothetical
escaping bug couldn't execute injected script. Unknown slugs get an uncached
404 page.

### `GET /api/links/<slug>`

Peek without bouncing: `200 {"url": "..."}` or `404 {"error": "not found"}`.
Same CORS policy as `POST`.

## Rich link previews

Short links posted to X/Reddit/Discord/Slack render a card instead of a naked
URL: the bounce page carries Open Graph + Twitter tags (`og:title`,
`og:description`, `og:site_name`, `og:type`, `og:url` pointing at the short
link, `og:image` = nanoodle.com's 1200×630 social card, and
`twitter:card: summary_large_image`).

The title is derived **once, at store time**, from the workflow already
encoded in the shared URL's fragment — no fetch, no extra data:

- `#a=` / `#a=u` (app links): the app's `name`, else the `<title>` of its
  packed `index.html`, else the graph chain below.
- `#g=` / `#j=` (graph links): a node-type chain like `text → llm → image`,
  in topological-ish order. Capped at 70 chars.
- Anything undecodable (or no fragment): a generic "A nanoodle workflow"
  card. A malformed fragment can never fail link creation.

The description is a fixed brand line for every card. Titles and
descriptions derive from user-supplied graph JSON, so they are HTML-escaped
before hitting the page.

**How this works with the body bounce:** card scrapers read the first HTML
response, and `GET /<slug>` serves the full page — OG tags included — with
the first byte; the meta-refresh/JS bounce doesn't get in the way of that.
One honest caveat: some scrapers (Facebook, and a few link-preview bots)
*follow* `<meta http-equiv="refresh">` and scrape the destination instead.
For nanolink that destination is nanoodle.com itself, which serves its own
site-wide OG tags — so those platforms show the generic nanoodle card rather
than the per-workflow title. No platform shows a broken preview.

## Deploy

### Deploy for nanoodle.com — quickstart

wrangler is not a dependency of this repo (the worker itself has zero
dependencies) — `npx` fetches it on first use. From the repo root:

```bash
npx wrangler login                       # opens the Cloudflare OAuth flow
npx wrangler kv namespace create LINKS   # prints the namespace id
# paste the id into wrangler.jsonc ("kv_namespaces" -> "id")
npx wrangler deploy
```

That gives you a live worker at `https://nanolink.<your-subdomain>.workers.dev`.
Then (optional, but what the nanoodle pages expect by default): route the
custom domain **link.nanoodle.com** to the worker in the Cloudflare dashboard
(Workers & Pages → nanolink → Settings → Domains & Routes → Add → Custom
domain). Keep the origin allowlists as is — `ALLOWED_ORIGINS` in `src/lib.mjs`
(whose URLs may be *shortened*) and `ALLOW_ORIGIN` in `src/worker.mjs` (the
CORS origin for browser calls) both point at nanoodle.com, and neither changes
with the host the worker itself is served from.

Run the tests (offline, no wrangler/miniflare needed — the worker is plain
`fetch` in/out and Node ≥ 20 has `crypto.subtle`, `Request`, and `Response`
as globals):

```bash
npm test
```

## Privacy stance

- **First-party.** The link never leaves nanoodle infrastructure; no external
  shortener sees your workflow.
- **No logs, no analytics, no cookies.** The worker records nothing about who
  created or followed a link. Workers observability is explicitly disabled in
  `wrangler.jsonc`. The only stored data is the `slug → {url, title, desc}`
  record — and the title/desc are computed from the URL itself, not from any
  request context.
- **No duplicate storage.** Deterministic slugs mean re-shortening the same
  link is a no-op — there is no per-request record to accumulate.
- `Referrer-Policy: no-referrer` on the bounce page, so the short URL isn't
  leaked onward either.

## Integrating with nanoodle

Both nanoodle surfaces — the editor (`index.html`, workflow `#g=` links) and
the app player (`play.html`, app `#a=` links) — now call this worker from
their Share popover's Shorten button, replacing the third-party shorteners
(da.gd/TinyURL) they used before:

- Each page declares the deployed worker as a single constant,
  **`NANOLINK_ORIGIN`**, next to its shortener code. It defaults to the
  canonical host `https://link.nanoodle.com`.
- Shortening is `POST {NANOLINK_ORIGIN}/api/links` with `{"url": <long link>}`,
  and the returned `shortUrl` is what gets copied/posted.
- **Fallback:** on *any* failure — network error, non-2xx, or a ~5s timeout
  (e.g. no instance deployed yet) — the pages simply keep offering the
  full-length share link, exactly as if shortening had been skipped. The long
  URL always works; nothing ever falls back to a third party.

Nothing in this repo depends on the pages — the API above is the whole
contract.

## Limitations

- **No delete/expiry.** Links live until the KV pair is removed by hand
  (`wrangler kv key delete`). Fine for share links; not a general shortener.
- **Takedown needs a cache purge too.** Bounce pages are edge-cached for a
  year (`immutable`), so deleting the KV key does **not** retract a bounce
  page an edge location has already cached — to fully take a link down,
  also purge the short URL from the Cloudflare cache (dashboard → Caching →
  Custom Purge, or the `purge_cache` API).
- **No rate limit on `POST /api/links`.** Any caller who can reach the
  endpoint can mint unlimited distinct KV records (up to 128 KiB each) —
  the CORS allowlist only gates *browsers*, not server-side callers. KV
  storage abuse is the exposure. If that matters for your deployment, put a
  Cloudflare rate-limiting rule (WAF → Rate limiting) in front of
  `POST /api/links`.
- **8-char slugs are truncated hashes**, not unguessable secrets. Anyone who
  can guess or observe a slug can read the link — same as any shortener.
  Don't shorten links you consider private.
- **nanoodle URLs only.** By design, the worker refuses to shorten anything
  off `nanoodle.com` / `www.nanoodle.com`.
- **KV is eventually consistent** — a freshly created link can take a few
  seconds to resolve from a different edge location.
- Collisions across the 64⁸ = 2⁴⁸ ≈ 2.8×10¹⁴ slug values are theoretically possible but not
  handled specially; a colliding URL would resolve to the first-stored link.

## License

MIT — see [LICENSE](LICENSE). Part of the
[nanoodle](https://github.com/nanoodlecom) project.
