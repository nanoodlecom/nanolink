# nanolink implicit state-machine audit — 2026-11-06

Audited baseline: `33cea28ae84f8f622789a790b445701b6741e119` (main).
Scope: every source module, route, test, configuration, README and GitHub workflow.
GitHub had no open PRs; PR #1 was already merged. No GitHub deployment records or
deployment workflow were present; release is a manual Cloudflare Worker deploy.
No live records were created, changed, or deleted during this audit.

## Inventory and invariants

| Machine | States / transitions | Invariant / recovery |
| --- | --- | --- |
| HTTP routing | preflight → 204; create; peek; image; bounce; home; unknown → 404; unsupported method → 405 | Responses keep CORS/no-store on JSON failures. HEAD retains status/headers and omits body. |
| Body intake | streaming → bounded bytes → JSON → validated target/card; malformed → 400; oversized → 413 | Bounds actual chunks, independent of Content-Length; cancels the reader before parsing excess input. |
| Target identity | validated exact HTTPS origin → SHA-256 → 8-char slug → durable owner | Same URL has same slug; different existing URL returns 409 without mutation. |
| Creation / import | no reservation → existing legacy KV record imported as published, or new original URL/card atomically reserved as pending → image replica → record replica → published | Every write to a slug goes through one durable owner. An in-memory promise queue covers network awaits; SQLite reservation survives eviction. |
| Failure / retry | pending → image or record write fails → 503 → retry loads original reservation → republishes original image and record → published | No success before record publication. A retry with a changed/missing card cannot alter the first choice. A rejected request does not poison the next request's queue. |
| Public image visibility | absent/uncommitted parent → 404; committed parent with img flag + image replica → immutable 200 | Orphan images are hidden. KV replication can temporarily yield 404, never cached. |
| Record versions | v1 bare URL / v2 JSON / v3 optional img → parsed record → validated allowed target | Existing links are read without bulk migration. Malformed/off-origin stored values fail closed with uncached 503. |
| Preview metadata | fragment recognized → base64 → bounded gunzip if needed → JSON → graph/app title; any failure → generic metadata | Best-effort metadata cannot reject an otherwise valid link. Graph traversal uses a queue cursor, avoiding quadratic shifts. |
| Bounce / fallback | immutable HTML → script replace; meta refresh and visible anchor also carry destination | URL/metadata escape HTML and JavaScript. Control characters cannot break the emitted script; CSP hashes the exact source. No long Location header. |
| Cache / propagation | published KV → eventual edge visibility → year-long immutable bounce/image; misses → no-store | No mutable card choices at the same URL after reservation. Replication delay remains; deletion alone cannot retract cached content. |
| Deployment | tests → exact-head review → merge → manual deploy with additive SQLite namespace → health | Keep existing LINKS namespace/routes/observability. No package publish (`private: true`). New creator storage is not an auth/permission change. |
| Takedown / repair | manual deletion and cache purge | Not executed. Removing KV alone leaves the durable reservation; any intentional repair/takedown must account for both stores and cached pages. |

## Reproduced defects and fixes

1. **First-creator race:** the baseline's eventually consistent get/put pair lets
   both concurrent callers write the image and link. A deterministic URL does not
   make different caller-supplied cards identical. Durable reservation and serialized
   publication now select one original choice, including after restart/stale reads.
2. **Partial writes and unstructured errors:** image success followed by record
   failure leaves a public orphan and throws out of fetch. Images now require a
   committed parent; a durable pending reservation supports safe retries; storage
   failures return CORS-enabled 503 with Retry-After and no private error detail.
3. **Silent hash collision:** an existing different URL incorrectly returned a
   successful short URL. Creation now returns 409 without modifying the old value.
4. **Unbounded intake:** request.json buffered an arbitrarily large request before
   validation. A streaming byte limit now rejects/cancels oversized input.
5. **HEAD body and corrupt-record handling:** HTML HEAD previously returned a body;
   invalid persistence could produce a bad redirect or uncaught error. HEAD is empty
   across all routes; invalid stored targets fail closed without immutable caching.
6. **Redirect script syntax:** allowed URL strings with literal control characters
   could break the JS string literal. They now receive uniform Unicode escaping.

Reproduce the first three defects and HEAD against the unchanged baseline:

```sh
mkdir -p /tmp/nanolink-baseline
git show 33cea28:src/worker.mjs > /tmp/nanolink-baseline/worker.mjs
git show 33cea28:src/lib.mjs > /tmp/nanolink-baseline/lib.mjs
NANOLINK_BASELINE_WORKER=/tmp/nanolink-baseline/worker.mjs node support/reproduce-baseline.mjs
```

Observed: 4 writes for two simultaneous creates; second image replaces first;
collision incorrectly returns 200; injected record failure escapes fetch; HEAD
has a nonempty response body. All experiments use isolated in-memory storage.

## Verification

- Baseline: 54 Node tests passed; the original suite did not exercise races/faults.
- Fixed: 64 Node tests, including stale misses, concurrent creation, failures before
  image/record publication, eviction recovery, collisions, malformed persistence,
  streamed cancellation, control characters, and HEAD.
- Official Miniflare/workerd: 40 concurrent retries preserve the original image;
  persistent restart preserves the choice; legacy records resolve; HEAD is empty;
  a maximum-size Unicode URL plus a 200 KiB card fits SQLite and KV.
- Wrangler deployment dry-run validates module exports, SQLite migration, existing
  LINKS namespace and the new CREATORS binding (no upload or release).

```sh
npm test
# On a sandbox that blocks test runner child processes:
node --test --test-isolation=none
# Optional real-runtime check with tools outside the zero-dependency repo:
npm install --prefix /tmp/nanolink-tools miniflare@4.20260730.0 wrangler@4.158.0
NANOLINK_MINIFLARE_MODULE=/tmp/nanolink-tools/node_modules/miniflare/dist/src/index.js node support/workerd-check.mjs
WRANGLER_SEND_METRICS=false /tmp/nanolink-tools/node_modules/.bin/wrangler deploy --dry-run
```

## Release and rollback runbook

The only pre-existing release is the service at https://link.nanoodle.com;
read-only HEAD on 2026-11-06 returned 200 with the expected CSP, no-referrer,
nosniff and cache headers. Existing Cloudflare authentication is expired and
cannot refresh noninteractively. No login flow or deployment was attempted.

1. Once the owner restores the existing Cloudflare session, inspect current
   deployments, bindings, routes and latest live version. Record the previous
   version ID; confirm no other owner has deployed changes since this review.
2. Additive migration `v1-creators` creates LinkCreator SQLite storage. It does
   not delete/change existing KV records, namespace IDs, credentials or permissions.
   Each first POST after rollout lazily imports an existing record. It adds one
   durable object/request path per slug; reads continue using KV.
3. Deploy the reviewed merge head with `wrangler deploy`, replacing all traffic.
   Do not split traffic between old direct-KV and new coordinated writers. A
   pre-coordinator write still in flight or invisible in KV during the first
   import cannot be made atomic retroactively. Allow legacy writes/replicas to
   settle before exercising new creates. A fully quiesced cutover requires an
   operational maintenance window; this code does not invent permission to
   change WAF rules or access settings.
4. Verify home, OPTIONS, malformed input, unknown-link 404, and a known existing
   public share link/HEAD. Check deployment version and route. If authorized to
   mint a permanent non-sensitive smoke link, verify POST, peek, bounce, card and
   repeated create; tests here deliberately avoid adding permanent live data.
5. For regression, deploy a forward rollback retaining LinkCreator export,
   CREATORS binding/migration, durable reservations and existing LINKS. Temporarily
   return 503 for POST while retaining read routes if writes are suspect. Never
   delete the new namespace or restore direct-KV writers; that would reintroduce
   the mutation race. A pre-migration version may be ineligible for platform
   rollback because it lacks the new durable class. Verify platform compatibility
   before any rollback. No rollback has been exercised against production.

## Remaining limits

- KV remains eventually consistent; a successful create can briefly resolve 404
  at another edge. Clients already fall back to the full URL on failures.
- No rate limiter or authentication is added. Storage abuse is an existing public
  endpoint exposure; CORS is not authentication. Adding WAF/billing/permissions is
  outside this patch. SQLite coordination adds storage/compute usage.
- PNG validation checks magic/IHDR dimensions and byte limits, not a complete PNG
  decode, CRC validation, or image content; it never promised content moderation.
- First rollout cannot reconstruct historical orphan ownership or past conflicting
  cards, and no audit scans/modifies private live workflows. Historical immutable
  caches remain as they were. Offline faults do not prove all edge propagation.
- Recovery resumes on the next POST, not a background alarm. A client abandoning
  an unsuccessful create may leave a pending reservation and hidden image replica.
- An operator intentionally removing a link must also handle the durable owner;
  a published reservation is retained and will not republish a manually deleted
  KV record on normal retries. Administrative takedown tooling is not supplied.
