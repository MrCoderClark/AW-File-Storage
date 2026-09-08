# Cloudflare edge rules — rate limiting & cache (spec 0022)

Applied in the Cloudflare dashboard on the **awvcard.com** zone (they can't live in
`wrangler.jsonc`). Documented here so they are reviewable and reproducible. They are the
**primary** edge defence — the edge sheds a flood before it reaches Worker compute; the
app-level throttles in `src/server/uploads.ts` are a backstop for a single authenticated user.

## Plan note (IMPORTANT)

awvcard.com is on the **Free** plan, which constrains rate limiting:
- **One** rate-limiting rule only.
- **No regex** — the `matches` operator is rejected ("not entitled: … an higher Advanced
  Rate Limiting plan is required"), so expressions use `starts_with` / `ends_with`.
- Mitigation **duration is fixed at 10 seconds** (longer needs Pro+).

So on Free we deploy **Rule A only** (below). Rules B and C are documented for a future Pro
upgrade but are **not** required today — see "Why B/C aren't needed on Free".

## Rate-limiting rule (Security → Security rules → Rate limiting rule)

### Rule A — public card surface — `contacts.awvcard.com` ✅ DEPLOYED (Free)
- **Expression**:
  ```
  (http.host eq "contacts.awvcard.com" and starts_with(http.request.uri.path, "/c/"))
  ```
  (covers `/c/<slug>`, `.vcf`, `.pdf`)
- **Characteristics**: by client IP.
- **Rate**: **60 requests / 10s** per IP.
- **Action**: **Block** for **10s** (Free maximum).
- **Why**: `/c/<slug>.pdf` regenerates a PDF per request (`pdf-lib`) and is `no-store`
  (kept that way so each save still counts, spec 0008); the landing page renders per
  request. This ceiling bounds a flood without affecting real scans/downloads. A persistent
  attacker just gets re-blocked every 10s.

### Rule B — hosted QR — `/api/cards/*/qr` (Pro only)
- **Expression**:
  ```
  (starts_with(http.request.uri.path, "/api/cards/") and ends_with(http.request.uri.path, "/qr"))
  ```
- **Rate**: 60 / 10s per IP → Block.

### Rule C — auth surface — `www.awvcard.com/api/auth/*` (Pro only)
- **Expression**:
  ```
  (http.host eq "www.awvcard.com" and starts_with(http.request.uri.path, "/api/auth/"))
  ```
- **Rate**: 20 / 10s per IP → Managed Challenge.

### Why B/C aren't needed on Free
- **QR (B)** is neutralised by the Cache Rule below — repeat hits serve from the edge cache
  instead of recomputing, so a flood mostly hits cache.
- **Auth (C)** is already covered in the app: Better Auth's DB-backed rate limiter plus the
  per-account lockout in `src/server/lockout.ts`.

## Cache rule — normalize the QR cache key (Caching → Cache Rules)

- **Expression** (no regex, Free-compatible):
  ```
  (starts_with(http.request.uri.path, "/api/cards/") and ends_with(http.request.uri.path, "/qr"))
  ```
- **Settings**: Eligible for cache; **Cache key → Ignore query string**; respect origin
  `Cache-Control` (the route sets `public, max-age=3600`).
- **Why**: the QR image depends only on the card id in the path, not on any query. Ignoring
  the query string means `?x=<random>` can't force a recompute past the edge cache
  (spec 0022 AC-3). A cold hit computes once; repeats serve from cache.

## Operator step (also noted in spec 0020)

Disable the **r2.dev public URL** on the `aw-files-public` bucket now that
`contacts.awvcard.com` is served by the Worker, so published cards are only reachable
through the Worker (which applies noindex + host gating + counting). The objects are
public by design, so this is hygiene, not a leak.
