# 0028 — Verification

**Backend foundation built 2026-09-10 (spec 0028 tasks 1–5, 8–10).** Bulk contact-card import: a
member POSTs already-mapped rows as JSON, the server re-validates and stores them, and a companion
cron drain publishes each valid row through the existing `publishVcardFromBytes` pipeline in bounded,
resumable batches. **Not yet verified live** (migration not applied at build time). The browser flow
(parse / map / preview / results UI — tasks 6, 7, 11) and the test suite (task 12) are **deferred**;
their verify steps get appended when they land.

_Steps derived from spec 0028 acceptance criteria. `/check verify` runs these; `/test` locks the
durable ones. Steps needing a signed-in browser session or the cron secret are marked._

## Commands

- [ ] `npx tsc --noEmit` → clean. _(passing at build time)_
- [ ] `npx vitest run test/no-db-bypass.test.ts test/vcard-builder.test.ts test/o365-provision.test.ts test/isolation.test.ts` → all pass (the shared-path + isolation regressions). _(passing at build time)_
- [ ] Apply the migration, then confirm the schema is live → tables `card_import` and `card_import_row` exist, `file.slug_base` column exists, and index `file_org_slug_base_uq` exists. → **AC-10, AC-11, AC-13 (storage half)**
  - `npx wrangler d1 migrations apply aw-file-storage --local` (local) / without `--local` (remote)
  - `npx wrangler d1 execute aw-file-storage --local --command "SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name IN ('card_import','card_import_row','file_org_slug_base_uq');"`

## API / manual (signed-in member of the active org, unless noted)

- [ ] `POST /api/cards/import` with `{ importId: <uuid>, rows: [3 valid contacts] }` → `200 { status: "pending", total: 3 }`; DB shows one `card_import` (status pending) and 3 `card_import_row` (outcome pending). The raw file is never sent — only mapped rows. → **AC-4, AC-5**
- [ ] On submit the drain starts **on its own** (no periodic cron): within a few seconds `GET /api/cards/import/<id>` → `status: "completed"`, `published: 3`, each row `outcome: "published"` with a `publicUrl`; the 3 cards resolve at their public addresses. (To drive it by hand: `POST /api/cron/card-import` with `Authorization: Bearer <CRON_SECRET>` **and** `Origin: <APP_URL>`.) → **AC-5, AC-6**
- [ ] Idle: with no import pending, nothing runs — `POST /api/cron/card-import` returns `{ drained: 0 }` and does not chain. → **on-demand model (see deviations)**
- [ ] Partial success: import where one row has no name → that row `outcome: "failed"` with a readable reason, the rest publish, import ends `completed_with_errors`. → **AC-8**
- [ ] Duplicate (same org): import a contact whose name already has a live card in the org → row `outcome: "skipped"`, reason "already exists in your organization"; the existing card is untouched (not overwritten, no second card). → **AC-7**
- [ ] Idempotency: re-`POST` the same `importId` → returns the existing import (`idempotent: true`), no second `card_import` row, no card double-published. → **AC-11**
- [ ] Row cap: `POST` with rows > `MAX_IMPORT_ROWS` (250) → `413` and **no** `card_import` row created; this refusal does not consume the rate limit. → **AC-9**
- [ ] Rate limit: the 6th accepted import within an hour (default `IMPORT_RATE_PER_HOUR` = 5) → `429`, enforced before any record is created. → **AC-9**
- [ ] Auth / tenancy: a signed-out `POST` → `401`; `GET` of an import id belonging to another org → `404`; rows only ever publish into the caller's active org. → **AC-10**
- [ ] Audit: an import writes one `card.import_started` and one `card.import_finished` audit event (visible in Activity), naming the actor and the counts. → **AC-10**
- [ ] O365 off: in an org with O365 configured, an imported card writes **no** CustomAttribute1 (the import publish path never triggers the O365 sync; cards are tagged `source: "import"`). → **AC-12**
- [ ] Crash resume / bounded retry (best as an integration test, task 12): a drain that stops mid-batch leaves the rest `pending`; the next drain finishes them, publishes nothing twice (keyed on `(import_id, row_number)`), and a row that fails `CARD_IMPORT_MAX_ATTEMPTS` (3) times ends `failed`, not looping; a stale `processing` row (claim older than 5 min) is reclaimed. → **AC-13**

## UI / manual — Upload Center wizard (tasks 6, 7, 11-progress)

- [ ] Open the Upload Center → drop or browse a **`.csv`** of contacts → the mapping wizard opens (the file is NOT queued as an upload). → **AC-1**
- [ ] The columns are auto-mapped from the headers; change a mapping and the sample value updates. A `.xlsx` opens the same wizard (its parser is a separate chunk, loaded only when an `.xlsx` is chosen). → **AC-1, AC-2**
- [ ] Continue to preview → each row shows Ready or "Skip (no name)"; the footer shows "N of M ready". Nothing has published yet. → **AC-3**
- [ ] Click **Import contacts** → only the mapped rows are POSTed as JSON (check the Network tab: no file body); the results view polls and rows move Waiting → Published, each published row links to its card. → **AC-3, AC-4, AC-5, AC-6**
- [ ] A sheet over 250 rows → the wizard shows the "limited to 250 rows" error (from the 413) and publishes nothing. → **AC-9**
- [ ] Closing the wizard after submit does not stop the import (it finishes server-side; cards appear on the Files page). → **AC-6**

## Acceptance-criteria coverage

- **Backend:** AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10, AC-11, AC-12, AC-13.
- **Browser flow (built this session):** AC-1 (Upload Center detects a `.csv`/`.xlsx` and parses it
  in the browser), AC-2 (column mapping with header auto-detect), AC-3 (preview + confirm gate),
  AC-4 (only mapped rows sent — the raw file never leaves the browser).
- **Still deferred:** task 11 retention (nightly purge of old `card_import` records) + surfacing an
  import in Activity; task 12 (the automated test suite).

## Implementation notes / deviations

- **AC-7 same-org dedup via a DB constraint.** Added `file.slug_base` (the unsuffixed `First_Last`)
  plus a partial unique index `(org_id, slug_base) WHERE slug_base IS NOT NULL AND deleted_at IS
  NULL`. Only the import publish path sets `slug_base`, so no other publish path (O365 auto-provision,
  Create-Card) changes behaviour. The index is the race guarantee (two concurrent drains for the same
  person cannot both publish); `publishVcardFromBytes` also does a fast pre-check read that matches an
  existing card by `slug_base` **or** `public_slug` (so a pre-existing manual/O365 card with the same
  name is also caught). Cross-org collisions still follow spec 0003 (a suffixed public slug).
- **Row payload stored.** `card_import_row.payload_json` (not in the spec's data-model sketch) holds
  the server-validated mapped `CardFields` so the background drain can rebuild and publish the vCard;
  `claimed_at` backs the stale-`processing` reclaim.
- **Publishing reuses `publishVcardFromBytes`** with a new `skipSameOrgSlugDuplicate` option; its
  result is now a discriminated union reporting `duplicate: "identical" | "same_org_slug"`.
- **`buildVcard`** gained an optional `department` (emitted as the second `ORG` component) and now
  omits an empty `EMAIL` line — both no-ops for existing callers.
- **Config** (`MAX_IMPORT_ROWS`, `IMPORT_RATE_PER_HOUR`, `CARD_IMPORT_DRAIN_BATCH`,
  `CARD_IMPORT_MAX_ATTEMPTS`) is read from env with code defaults; added to `wrangler.jsonc` `vars`.
- **On-demand, in-process drain (deviation from the spec's "scheduled drain each tick").** By owner
  request, publishing is event-driven, not polled. The submit request runs the drain **in-process**
  on `ctx.waitUntil` (`kickDrain` → `runDrainRun`) — the same proven background pattern as
  `triggerO365Sync`, needing no self-fetch and no secrets — so a small import publishes right there
  in the background. One run drains a bounded number of batches (`MAX_BATCHES_PER_RUN` × the drain
  batch, ~60 rows) to stay within a single invocation's subrequest budget. A LARGE import that
  exceeds one run hands off to a fresh invocation via a best-effort POST to `/api/cron/card-import`
  (`continueDrainViaFetch`, needs `APP_URL` + `CRON_SECRET` + an `Origin` header); if that loopback
  can't run on the platform, the **nightly safety-net** call to the same endpoint (from the EXISTING
  `cron/src/index.ts` `0 3 * * *` trigger — **no new schedule**) finishes the rest. Nothing polls
  while idle.
  - **Why the first attempt hung at "Waiting":** the original design kicked the drain via a Worker
    fetching its own route (loopback), which failed silently on Cloudflare, so no row was ever
    claimed. Running the drain in-process fixes it. A row left `pending` by that first attempt drains
    on the next run (any later import's kick, a manual cron call, or the nightly net).
  - **The spec's Decision/Feature-design still describe the periodic model — update it via
    `/architect 0028: on-demand in-process drain instead of a periodic cron tick`.**
- **Browser parser dependency.** Added `xlsx` (SheetJS) `0.18.5` for `.xlsx` parsing, loaded via a
  dynamic `import("xlsx")` in `src/components/spreadsheet-import.tsx` so it is a separate chunk, not
  in the initial bundle. CSV is parsed by a small in-house parser (no dependency). **Security note:**
  the npm `xlsx` 0.18.5 carries prototype-pollution / ReDoS advisories (the patched builds live on
  SheetJS's own CDN, not npm). Exposure here is low — parsing runs client-side in the uploader's own
  browser on their own file, never server-side — but a follow-up is to move to the SheetJS CDN build
  (or a lighter reader) and re-audit. Loads fine under the enforced CSP (`script-src 'self'`, no
  `unsafe-eval` needed).
- **Entry point.** By owner choice the flow lives INSIDE the Upload Center: a `.csv`/`.xlsx` drop
  opens the mapping wizard (`SpreadsheetImport`) instead of being stored as a private file; other
  files still upload normally. No separate route or nav entry.
