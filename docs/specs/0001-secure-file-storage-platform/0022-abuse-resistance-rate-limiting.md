# 0022. Abuse resistance — rate limiting & cost controls for public and expensive endpoints

**Date**: 2026-09-07
**Status**: Proposed

## Summary

Authentication routes are rate-limited (Better Auth `rateLimit`, DB-backed, plus the
per-account lockout in `src/server/lockout.ts`), but the **application** endpoints have
no rate limiting, and several **unauthenticated, computationally expensive, uncacheable**
public endpoints can be hammered to burn Worker CPU and cost. This spec adds layered
abuse resistance: Cloudflare WAF rate-limiting rules for the public and auth surfaces,
lightweight app-level throttles on the most abusable authenticated actions, and cheap
cost controls (caching the QR image, bounding PDF work) so a flood degrades gracefully
instead of amplifying.

## Context

Verified in the current code:

- **`/c/<slug>.pdf`** (`src/app/c/[slug]/route.ts`) generates a PDF **on every request**
  with `pdf-lib` — R2 GET + `parseVcard` + logo fetch + `buildCardPdf` — and returns
  `Cache-Control: private, no-store`. Public host, unauthenticated, uncached. Each hit is
  real CPU and R2 I/O; there is no rate limit and no cache.
- **`/c/<slug>`** landing page — public, `no-store`, renders HTML per request (R2 GET +
  parse + social/logo resolution).
- **`/api/cards/[id]/qr`** (`src/app/api/cards/[id]/qr/route.ts`) — **public by design**,
  encodes a QR with the `qrcode` lib on every request; `Cache-Control: public, max-age=3600`
  (so the edge *can* cache it, but a cache-busting query or cold cache re-computes).
- **App API routes** (`/api/uploads`, `/api/uploads/finalize`, `/api/files/[id]/link`,
  `/api/files`, `/api/cards/[id]/stats`, etc.) — authenticated, but no per-user/app rate
  limit. `POST /api/uploads` reserves a `file` + `upload_session` row and issues a
  presigned PUT on each call; a script could create many pending rows (bounded by quota
  on real bytes, but the rows/links themselves are unbounded before finalize).
- The spec-0001 stack table already names **"Cloudflare WAF rate limiting rules on the
  auth routes"** as the intended first layer — it is specced but the app-wide/public-route
  rules are not yet defined here.
- **vCard field bounds.** `validateVcard` (`src/server/vcard.ts`) enforces structure +
  `FN` + version and a total-size cap (`MAX_VCARD_BYTES` = 256 KB) but does not bound the
  number of properties or individual field lengths. Rendering escapes everything, so this
  is not an XSS or overflow risk — it is an abuse/quality bound (a pathological 256 KB card
  is published and re-parsed on every landing/PDF hit).

Why it matters: these are **Medium** availability/cost issues, not data-exposure ones. A
single attacker with a valid published slug can drive repeated PDF/landing generation with
no ceiling; the bill and CPU scale with their request rate. Cloudflare is the right primary
layer (a network rule sees the flood a per-account counter cannot), with cheap app-side
backstops.

## Requirements

**User stories**:
- As the platform owner, I want a request flood against a public card URL (landing, `.vcf`,
  `.pdf`, QR) to be rate-limited at the edge, so one abuser can't run up CPU/cost.
- As the platform owner, I want the expensive PDF/QR generation cached or bounded, so
  normal repeat traffic doesn't recompute needlessly.
- As the platform owner, I want the sensitive authenticated actions (upload reservation,
  download-link issuance, password reset, invitations) throttled per user/IP, so an
  automated client can't abuse them.

**Acceptance criteria**:
- **AC-1 (WAF rules — public card surface)**: A Cloudflare rate-limiting rule limits
  requests to `contacts.awvcard.com/c/*` and `/api/cards/*/qr` per client IP to a sane
  ceiling (e.g. N requests / 10s, tuned so real scans/downloads never trip it). The rule
  set is documented as config in the repo (e.g. `config/`), so it is reviewable and
  reproducible, not only clicked in the dashboard.
- **AC-2 (WAF rules — auth surface)**: A Cloudflare rate-limiting rule limits
  `www.awvcard.com/api/auth/*` (sign-in, reset, verify) per IP, complementing the existing
  Better Auth DB rate limit and per-account lockout. Documented alongside AC-1.
- **AC-3 (QR cache)**: `/api/cards/[id]/qr` output is cacheable and actually cached — keep
  `Cache-Control: public, max-age=…`, and ensure the response does not vary on a
  cache-busting query (ignore unknown query params for the cache key, or strip them). A
  cold hit computes once; repeat hits are served from cache.
- **AC-4 (PDF cost control)**: **Chosen: (b)** — keep `/c/<slug>.pdf` at `no-store` and rely
  on the AC-1 WAF ceiling, so every save still counts under the `pdf` metric (spec 0008);
  shared-caching it would drop the count on cache hits. (Option (a), a short `s-maxage` on the
  public host, stays available if PDF cost ever outweighs metric precision — the PDF holds no
  per-viewer data, being built from the public `.vcf`.)
- **AC-5 (app-level throttle on sensitive actions)**: A lightweight, DB-backed per-user
  throttle guards `POST /api/uploads` (upload reservation) and `POST /api/files/[id]/link`
  (signed-link issuance), returning `429` with a `Retry-After` when exceeded.
  **Implemented with no new table**: uploads use a **concurrent-pending cap** (a user with
  ≥50 un-finalized, unexpired `upload_session` rows → 429) rather than a rate, so a genuine
  bulk upload — which finalizes each reservation quickly — is never throttled while a script
  that reserves without finalizing is stopped; the link throttle counts the user's
  `file.link_created` `audit_event` rows in the last 60s (≥60 → 429). Limits are generous
  enough never to affect a real user. Invitation resend is already rate-limited (spec 0005
  AC-16); sign-in/reset are covered by Better Auth's limiter + the lockout.
- **AC-6 (pending-upload hygiene)**: Satisfied directly by AC-5's concurrent-pending cap —
  one user can hold at most 50 un-finalized reservations; abandoned ones expire (15-min TTL)
  and stop counting, and the existing scheduled cleanup reclaims them.
- **AC-7 (vCard content bounds)**: `validateVcard` — the single publish gate for every path
  (upload finalize, create, edit, auto-provision) — additionally rejects a card whose raw
  content exceeds **256 KB** (this also closes a real gap: the upload reservation only checks
  the client's *declared* size, so `finalizeUpload` never re-capped the actual vCard bytes)
  or has more than **512 content lines**, each with a readable reason. A per-field length cap
  was intentionally **not** added — it would reject a legitimate embedded `PHOTO`, and the
  total-byte + line-count bounds already stop pathological input. Real cards are far under both.
- **AC-8 (no regression)**: Normal usage — scanning a QR, opening a landing page,
  downloading a `.vcf`/`.pdf`, uploading, creating a card, signing in — is unaffected;
  limits are set well above real traffic and verified not to trip in the happy path.

## Decision

**Chosen approach**: put the primary ceiling at the **Cloudflare edge** (WAF
rate-limiting rules for the public card surface and the auth surface, documented as repo
config), add **cheap caching** to the two expensive public generators (QR already
cacheable; allow short shared-cache on the public PDF since it holds no private data), and
add a **thin DB-backed app throttle** (reusing the lockout primitives) on the few sensitive
authenticated actions. Bound vCard fields in the existing validator.

**Rejected**:
- App-only rate limiting with no WAF — a Worker-level counter still runs Worker code per
  request (it pays the cost it's trying to avoid); the edge rule sheds load before compute.
- A new rate-limit dependency / Durable Object counter — unnecessary; Better Auth's
  DB-backed limiter and the existing `accountLock` pattern already exist in-repo.
- Caching the landing HTML aggressively — it's cheap-ish and the counting relies on real
  hits; leave it `no-store` and let the WAF ceiling handle floods.

## Feature design

**Edge (Cloudflare WAF).** Rate-limiting rules documented in
`config/cloudflare-rate-limits.md` (mirroring how `config/r2-cors.json` documents CORS):
- `contacts.awvcard.com` `/c/*` and `/api/cards/*/qr`: per-IP request ceiling over a short
  window; action = block/challenge with a short timeout.
- `www.awvcard.com` `/api/auth/*`: per-IP ceiling, complementing Better Auth's limiter.
- Plus a **Cache Rule** normalising the QR cache key (ignore query string) so a cache-busting
  query can't force recompute (AC-3).

**QR caching.** In `src/app/api/cards/[id]/qr/route.ts`, keep `public, max-age=3600` and
make the handler ignore unrecognized query params so a `?x=random` can't force recompute
past the edge cache (compute from the resolved landing URL only, which it already does).

**PDF cost control.** In `src/app/c/[slug]/route.ts`, on the **public host only**, serve
the `.pdf` with `Cache-Control: public, s-maxage=<short>, max-age=0` (edge-cacheable,
browser revalidates) — the PDF is derived from the public card and carries no per-viewer
data. On the app host keep `no-store` (it's a gated staff preview). Counting stays
fire-and-forget as today. Document the decision inline.

**App throttle (no new table).** In `src/server/uploads.ts`, `requestUpload` counts the
user's un-finalized, unexpired `upload_session` rows (`completed_at IS NULL AND expires_at >
now`) and throws `UploadError(429, …, 60)` at ≥50 — a concurrent-pending cap, not a rate, so
bulk upload is unaffected; `createPrivateLink` counts the user's `file.link_created`
`audit_event` rows in the last 60s and throws at ≥60. `UploadError` gains an optional
`retryAfterSeconds`, which the two routes (`/api/uploads`, `/api/files/[id]/link`) surface as
a `Retry-After` header. Reuses existing tables — no migration, no new dependency.

**vCard bounds.** In `validateVcard`, after the structural checks, reject when
`nonEmpty.length` exceeds a generous line cap or any single line's value exceeds a
per-field cap, each with a clear reason string.

**Key invariants**:
- The edge sheds a flood before it reaches Worker compute.
- Expensive public generators are cacheable/bounded; no per-viewer data is ever shared-cached.
- App throttles reuse existing primitives; limits never affect real users.

## Verification

See `0022-verify.md`. Checks: a burst of requests to `/c/<slug>.pdf` and `/api/cards/<id>/qr`
from one IP is rate-limited at the edge (observed 429/challenge) while a normal cadence is
not; a repeated QR fetch is served from cache (no recompute) and a cache-busting query does
not defeat it; the public `.pdf` is edge-cacheable and identical bytes across viewers (no
private data); exceeding the app throttle on `POST /api/uploads` and
`POST /api/files/[id]/link` returns `429` with `Retry-After`; `validateVcard` rejects a card
with too many lines / an oversized field (unit test) and still accepts a normal card; the
happy path for scan/download/upload/sign-in is unaffected. Document which mechanism satisfies
AC-6 (throttle vs concurrent-session cap vs cleanup reclaim).

## Out of scope (later)

Per-org quotas on public request volume; bot management / Turnstile on the landing page;
signed/expiring public card URLs (the product intent is stable public addresses, so this is
explicitly not pursued here); moving analytics counting to a queue.
