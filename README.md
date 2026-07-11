# nanolink

**First-party link shortener for [nanoodle](https://nanoodle.com) share
links.** A tiny Cloudflare Worker + KV that turns a 10–60KB share URL into
`https://<your-worker>/<8-char-slug>` — with no analytics, no logs, and no
third party ever seeing the workflow.

Zero dependencies. One worker file, one KV namespace.

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
- Errors return `4xx` with `{"error": "..."}`.
- CORS: browser calls are allowed from `https://nanoodle.com` only
  (`OPTIONS` preflight handled).

### `GET /<slug>`

Returns the body-bounce page (`200 text/html`): `<meta http-equiv="refresh">`,
inline `location.replace(...)`, and a visible "Continue to nanoodle →" link.
Sent with `Referrer-Policy: no-referrer`, `noindex`, and
`Cache-Control: public, max-age=31536000, immutable` — safe because a slug's
content is immutable by construction (it *is* the hash of the URL). Unknown
slugs get an uncached 404 page.

### `GET /api/links/<slug>`

Peek without bouncing: `200 {"url": "..."}` or `404 {"error": "not found"}`.
Same CORS policy as `POST`.

## Deploy

```bash
npx wrangler kv namespace create LINKS   # prints the namespace id
# paste the id into wrangler.jsonc ("kv_namespaces" -> "id")
npx wrangler deploy
```

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
  `wrangler.jsonc`. The only stored data is the `slug → url` pair itself.
- **No duplicate storage.** Deterministic slugs mean re-shortening the same
  link is a no-op — there is no per-request record to accumulate.
- `Referrer-Policy: no-referrer` on the bounce page, so the short URL isn't
  leaked onward either.

## Integrating with nanoodle

The nanoodle editor's shorten popover currently uses third-party shorteners.
The integration is a future PR in the main repo: POST the share link to this
worker's `/api/links` instead, and use the returned `shortUrl`. Nothing in
this repo depends on that PR — the API above is the whole contract.

## Limitations

- **No delete/expiry.** Links live until the KV pair is removed by hand
  (`wrangler kv key delete`). Fine for share links; not a general shortener.
- **8-char slugs are truncated hashes**, not unguessable secrets. Anyone who
  can guess or observe a slug can read the link — same as any shortener.
  Don't shorten links you consider private.
- **nanoodle URLs only.** By design, the worker refuses to shorten anything
  off `nanoodle.com` / `www.nanoodle.com`.
- **KV is eventually consistent** — a freshly created link can take a few
  seconds to resolve from a different edge location.
- Collisions across ~4×10¹⁴ slug values are theoretically possible but not
  handled specially; a colliding URL would resolve to the first-stored link.

## License

MIT — see [LICENSE](LICENSE). Part of the
[nanoodle](https://github.com/nanoodlecom) project.
