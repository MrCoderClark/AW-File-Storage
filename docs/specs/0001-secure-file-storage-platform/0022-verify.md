# 0022 — Verification

## What shipped (code)

- `src/server/vcard.ts` — `validateVcard` now rejects a card whose raw content exceeds
  **256 KB** or has more than **512 content lines**, each with a readable reason. This is the
  single publish gate (upload finalize, create, edit, auto-provision), so it also closes the
  gap where `finalizeUpload` never re-capped the *actual* uploaded vCard bytes (only the
  client-declared size was checked at reservation).
- `src/server/uploads.ts` — per-user throttles: `requestUpload` caps **concurrent
  un-finalized** uploads (≥50 pending, unexpired `upload_session` rows → 429; a bulk upload
  finalizes each quickly so it never trips); `createPrivateLink` limits ≥60 `file.link_created`
  audit rows/min → 429. Reuses existing tables (no migration). `UploadError` carries
  `retryAfterSeconds`.
- `src/app/api/uploads/route.ts`, `src/app/api/files/[id]/link/route.ts` — surface
  `Retry-After` on a 429.

## What shipped (config — apply in Cloudflare dashboard)

`config/cloudflare-rate-limits.md`: WAF rate-limiting rules for `contacts.awvcard.com/c/*`,
`/api/cards/*/qr`, and `www.awvcard.com/api/auth/*`, plus a Cache Rule that ignores the query
string on `/api/cards/*/qr`. These are the primary edge defence; the app throttles are a
backstop for a single authenticated user.

## Checks

1. **Unit (`npm test`)** — `validateVcard` accepts a normal card, rejects a >256 KB card
   ("too large"), and rejects a >512-line card ("too many lines"). See
   `test/vcard-builder.test.ts`.
2. **Upload throttle** — reserve 50 uploads without finalizing (as one user) → the 51st returns
   `429` with `Retry-After: 60`; a normal bulk upload (which finalizes each reservation) never
   trips it because pending count stays low.
3. **Link throttle** — >60 `POST /api/files/[id]/link` within a minute as one user → `429` +
   `Retry-After`.
4. **PDF counting intact** — `/c/<slug>.pdf` still `Cache-Control: private, no-store`; each save
   still increments the `pdf` metric (spec 0008). Cost is bounded by the WAF rule, not caching.
5. **QR cache** (after the Cache Rule is applied) — repeated `/api/cards/<id>/qr` serves from the
   edge cache; `?x=<random>` does **not** force a recompute (cache key ignores the query string).
6. **WAF** (after rules are applied) — a burst to `/c/<slug>.pdf` or `/api/cards/<id>/qr` from one
   IP is blocked/challenged; a normal cadence is not; `/api/auth/*` bursts are challenged.

## Out of scope (later)

Bot management / Turnstile on the landing page; moving analytics counting to a queue;
per-org public-request quotas.
