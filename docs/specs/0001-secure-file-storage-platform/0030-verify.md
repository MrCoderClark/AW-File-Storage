# 0030 — Verification: Per-visitor engagement analytics

Companion to [0030-visitor-analytics.md](0030-visitor-analytics.md). Additive
migration only (a new `card_visit_event` table; no existing table is rebuilt).
`/check verify` runs these; `/test` locks the durable ones.

## Commands

- [ ] `npx drizzle-kit generate` → the new `migrations/0030_*.sql` is **CREATE
      TABLE `card_visit_event` + 4 indexes only**, with **no `DROP TABLE`** and no
      rebuild of `file`/`organization`. → AC-1, AC-10
- [ ] Apply local + `--remote`
      (`wrangler d1 migrations apply aw-file-storage --local` / `--remote`), then
      `wrangler d1 execute aw-file-storage --local --command "SELECT name FROM sqlite_master WHERE name='card_visit_event'"`
      returns the table. → AC-1
- [ ] `npm run typecheck` → clean.
- [ ] `npm test` → `test/visits.test.ts` + `test/visits-migration.test.ts` pass
      (UA derivation, capture field mapping + cf-absent fallback, best-effort never
      throws, unique count, feed filters/keyset/org-scope, purge cutoff, CREATE-only
      migration). → AC-1, AC-3, AC-5, AC-6, AC-8, AC-9, AC-10
- [ ] `wrangler secret put IP_HASH_SALT` on the **app** worker before relying on the
      unique count in prod (an unset salt still works, just unsalted). → AC-5

## Automated tests (`test/visits.test.ts`, `test/visits-migration.test.ts`)

- **Device derivation (AC-1)** — `describeUserAgent`/`formatVisitorDevice` map common
  UAs to browser/OS/device and are null-safe.
- **Capture (AC-1)** — one row per hit with metric/IP/referrer/src; cf-present maps the
  geo/network columns; cf-absent leaves them null with country from the `CF-IPCountry`
  header.
- **Best effort (AC-3)** — `recordCardVisit` never throws even when the write can't happen.
- **Unique count (AC-5)** — same IP+UA+day → 1; a different IP → 2 (`COUNT(DISTINCT visitor_hash)`).
- **Feed (AC-6, AC-8)** — newest first, filter by card + metric, keyset pages, and one
  org never sees another's events.
- **Retention (AC-9)** — a >12-month row is purged, a recent row kept, the `card_stat_daily`
  rollup untouched.
- **Migration (AC-10)** — the `card_visit_event` migration is CREATE-only, no DROP/rebuild.

## Manual (in-browser)

1. **Capture (AC-1):** as owner/admin, hit a published card on the **public host**
   (`contacts.awvcard.com/c/<slug>` view; `?src=qr` scan; `/c/<slug>.vcf` download;
   `/c/<slug>.pdf` save). Open **Activity logs → Analytics tab** → four rows appear,
   newest first, each with the card, activity badge, Eastern time, IP, resolved
   location, network, and device; **Details** expands referrer/source/timezone/UA.
2. **Unique count (AC-5):** two loads from the same device/day → **Unique visitors = 1**;
   a load from a different network (or phone on cellular) → 2.
3. **Filters (AC-6):** switch the range, the metric chips (Views/Scans/Downloads/PDF
   saves), and the **All cards** dropdown → the list and unique count update; **Load
   more** pages through older rows.
4. **Admin only (AC-7):** as a **member**, `/activity` shows **no Analytics tab**, and
   `GET /api/analytics/visitors` returns **403**. Members still see their own aggregate
   card stats on Files/Dashboard.
5. **App host + bots (AC-2, AC-4):** preview a card on **www** while signed in → **no**
   new Analytics row and no count. A bot/link-preview UA (e.g. `curl`) on the public
   host → **no** row and no count (same gate as the rollup + `isCountableUserAgent`).
6. **Privacy link (AC-11):** while **signed out**, the footer **Privacy** link loads
   `/privacy`, describing the data collected, the legitimate-interest basis, the
   12-month retention, and a contact address.
7. **Retention (AC-9):** back-date a `card_visit_event.created_at` older than 12 months,
   `POST /api/cron/analytics-purge` (bearer `CRON_SECRET` + `Origin: <APP_URL>`) → the
   old row is gone, a recent row and the `card_stat_daily` rollup remain.
8. **Isolation (AC-8):** a second org's admin never sees the first org's visitor events.
