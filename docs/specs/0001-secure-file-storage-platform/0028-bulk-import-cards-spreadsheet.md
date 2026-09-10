# 0028. Bulk import contact cards from a spreadsheet

**Date**: 2026-09-10
**Status**: In Progress

## Summary

Staff can create and publish many contact cards at once by uploading a spreadsheet (a CSV or an
Excel `.xlsx` file) instead of typing each card into the Create Card form or uploading one `.vcf`
at a time. The browser reads the spreadsheet, the user maps its columns to card fields and reviews a
preview, and on confirm the mapped rows go to the server, which validates each one and publishes the
valid rows as normal contact cards through the existing publish pipeline. Bad rows are reported with
a reason; the good rows still publish.

## Context

The product publishes contact cards (vCards) to stable public web addresses. Two ways to make a card
exist today: type the details into the Create Card form (spec 0006), or upload a ready made `.vcf`
file into the Upload Center (spec 0003). Neither scales to a whole team. Staff hold their contact
lists as spreadsheets (a real example: columns for First Name, Last Name, Full Name, Work Phone,
Mobile Phone, Fax, Email, Organization, Job Title, Department, Address, City, State, Zip Code,
Country, Website), and turning fifty of those into fifty published cards by hand is exactly the
tedium this feature removes.

Three forces shape the design. First, the Cloudflare Worker bundle stays small, so a heavy
spreadsheet parser must not ship inside it. Second, the cards are real people's personal data made
deliberately public, so publishing stays a validated, audited, reversible act (the rules in spec
0003 do not bend for a bulk path). Third, publishing many cards in one web request would risk the
Worker's per request CPU and subrequest limits, so the actual publishing runs in the background.

Not deciding leaves staff copying contacts one at a time, which is the friction that made an
engineer expect (wrongly, until now) that the app already imported spreadsheets.

## Requirements

**User stories**:
- As a staff member, I want to upload a spreadsheet of contacts and publish them all as cards in one
  pass, so that onboarding a whole team is one action rather than fifty.
- As a staff member, I want to line up my spreadsheet's columns with the card fields myself, so that
  my own column names and order do not have to match a fixed template.
- As a staff member, I want to see which rows are good and which are not before anything publishes,
  so that I never publish a broken or half empty card by accident.
- As a staff member, I want the rows that are fine to publish even when a few rows are bad, so that
  one typo does not block the whole list.

**Acceptance criteria**:
- **AC-1**: A signed in member can open the bulk import flow, choose a CSV or `.xlsx` file, and the
  file is read into rows in the browser. The raw file is never sent to the server.
- **AC-2**: The user maps spreadsheet columns to card fields (name parts and full name, job title,
  organization, department, email, work / mobile / fax phone, street / city / state / zip / country,
  website). The mapping decides how each row becomes a vCard.
- **AC-3**: A preview lists every parsed row with a per row valid or invalid status and a reason for
  each invalid one. Nothing publishes until the user confirms.
- **AC-4**: On confirm, only the mapped rows (as JSON) are sent to the server. The raw spreadsheet is
  never uploaded or stored anywhere.
- **AC-5**: The server re validates every row (it never trusts the browser's judgment), builds a
  normalised vCard by the existing rules (specs 0003 and 0006), and publishes each valid row through
  the existing publish pipeline, producing a normal published card (a `files` row) and its own
  publish audit event.
- **AC-6**: Publishing runs in the background: the confirmed rows are stored as `pending` and drained
  in bounded batches by a scheduled job, so no single web request publishes the whole import. The user
  can leave and come back; the import shows progress and always reaches a final per row report
  (published, skipped, or failed with a reason), with no row left stuck.
- **AC-7**: Duplicate handling respects the existing slug rules (spec 0003: slugs are globally unique;
  a collision appends a random suffix, never overwrites). A row whose derived slug matches a card
  already published in the SAME organization (the same person already has a card) is skipped and
  reported, never overwritten or duplicated. A collision with a DIFFERENT organization's card follows
  spec 0003 (a suffixed address; the other org's card is untouched). The same org duplicate check is
  enforced by a database uniqueness constraint, not a read then write, so two rows (in one sheet or
  across concurrent drains) that derive the same slug cannot both publish.
- **AC-8**: A row that cannot make a valid card (for example no usable name) is reported as failed
  with a readable reason, while the valid rows in the same import still publish (partial success).
- **AC-9**: An import is capped at a maximum number of rows (default 250) and refused before any
  import record is created when the row count exceeds it; that refusal does not count against the
  rate limit. A per user hourly rate limit counts accepted import submissions (each POST that creates
  a `card_import`) and is enforced before the record is created.
- **AC-10**: Both new tables carry `org_id` and are reached only through `orgDb(orgId)`. The import
  is restricted to a signed in member of the active organization, and writes one audit event when it
  starts and one when it finishes.
- **AC-11**: Re submitting the same import (same client generated import id) is idempotent: it does
  not double publish and does not create a second import record.
- **AC-12**: Imported cards do not trigger the Office 365 sync, even in an organization that has O365
  configured.
- **AC-13**: Row publishing is idempotent and resumable. If a drain crashes part way through a batch,
  the next drain reprocesses only rows not yet in a terminal outcome, a row is never published twice
  (keyed on `import_id` + `row_number`), and a row that keeps failing is marked `failed` after a
  bounded number of attempts rather than retried forever.

## Options considered

### Option 1: Browser parses, server validates, a scheduled drain publishes (recommended)

The browser reads the spreadsheet with a parser that ships only in the client bundle, runs the
column mapping and preview, and sends the confirmed rows as JSON. The server re validates each row
and stores them as `pending`; a scheduled route (the same companion cron pattern that already runs
the Office 365 jobs) drains a bounded batch each tick and publishes each row through the existing
`publishVcardFromBytes` path.

**Pros**:
- The spreadsheet parser stays out of the Worker bundle entirely.
- The interactive mapping and preview live where the data already is (the browser), so no round trip
  to show a preview.
- No new background infrastructure: it reuses the live companion cron drain pattern, and a crashed
  tick simply resumes on the next one.

**Cons**:
- The server must fully re validate untrusted rows; the browser's preview is a convenience, not a
  source of truth.
- Publishing is not instant; rows complete over successive cron ticks rather than in one moment.

### Option 2: Upload the raw file, parse and publish in the Worker

The browser uploads the spreadsheet to R2, the Worker parses it server side and publishes the rows.

**Pros**:
- Parsing happens on trusted server code, so there is one validation pass, not two.

**Cons**:
- A spreadsheet parser (for `.xlsx`) ships inside the Worker bundle, which the project deliberately
  keeps small.
- The raw spreadsheet, full of personal data, lands in R2 and must be secured and later purged.
- Parsing plus publishing many rows in the Worker presses on CPU and subrequest limits.

### Option 3: Synchronous bulk publish in the confirm request

Like Option 1, but the confirm request publishes every row inline and returns when done. The Office
365 auto provision job (`provisionCardsAllOrgs`) already publishes generated vCards in a loop this
way, so there is a precedent.

**Pros**:
- Simplest control flow; no scheduled drain, no polling, arguably no import record needed.

**Cons**:
- That precedent is a system triggered job over a bounded directory; a member triggered import of up
  to the row cap doing dozens of public bucket copies and cache operations in one request presses on
  the Worker's CPU and subrequest limits and blocks the user until done.
- No natural way to show progress or to recover a part finished import.

## Decision

**Chosen option**: Option 1: the browser parses and previews, the server re validates and stores the
rows, and a scheduled drain (the existing companion cron pattern) publishes each row in the
background through the existing `publishVcardFromBytes` path.

**Implementation skills**: `tailwindcss-v4` (`.claude/skills/tailwindcss-v4/`) · `frontend-design` (`.claude/skills/frontend-design/`) · `playwright` (`.claude/skills/playwright/`)

## Rationale

The bundle size force decides parsing location: the only way to accept `.xlsx` without a parser in
the Worker is to parse in the browser, so Option 2 is out despite its single validation pass. The
personal data force reinforces it: parsing in the browser means the raw sheet never needs to reach
R2, so there is less personal data at rest to secure and purge.

The Worker limits force decides the publishing model. A textbook answer would be a Cloudflare Queue,
but this project has no queue wired: the `queues` block in `wrangler.jsonc` is commented out, the
OpenNext config declares no queue adapter, and every background job today runs as an `/api/cron/*`
route triggered by a separate companion cron Worker (the Office 365 sync, provision, purge, and
nightly cleanup all work this way). One of those, `provisionCardsAllOrgs`, already publishes
generated vCards in a loop through `publishVcardFromBytes`. Reusing that live drain pattern, rather
than standing up the project's first Queue and solving how a queue consumer attaches to an
OpenNext built Worker, is the aligned, lower risk choice; a real Queue is a sensible future upgrade
if import volume ever outgrows a bounded per tick drain (noted in Follow-up). Option 3 (publish
inline) is out because a member triggered import up to the cap would do that work in one request and
press on the Worker's limits.

Re validating on the server is not a cost to avoid but the correct posture: the browser preview is a
courtesy to the user, and spec 0003's rule that nothing is public until the server validated it holds
for every row.

## Feature design

**Data model sketch**:

`card_import` (one row per import run):
- `id` (primary key)
- `org_id` (FK organization, not null, leads every index)
- `actor_user_id` (FK user, not null)
- `status` (not null): `pending` | `processing` | `completed` | `completed_with_errors` | `failed`
- `total_rows`, `published_count`, `skipped_count`, `failed_count` (int, not null, default 0)
- `created_at`, `updated_at` (not null), `completed_at` (nullable)

`card_import_row` (one row per source spreadsheet row):
- `id` (primary key)
- `import_id` (FK card_import, not null, indexed)
- `org_id` (FK organization, not null)
- `row_number` (int, not null, the source row for the report)
- `contact_name` (text, nullable, the derived full name shown in the report)
- `outcome` (not null): `pending` | `processing` | `published` | `skipped` | `failed`
- `reason` (text, nullable, why skipped or failed)
- `attempts` (int, not null, default 0, the drain attempt count for bounded retry)
- `file_id` (FK files, nullable, the published card when `outcome = published`)
- `created_at`, `updated_at` (not null)

Relationships: `card_import` 1:N `card_import_row`; `card_import_row` N:1 `files` (nullable). The
published cards themselves are ordinary `files` rows created by the existing pipeline; these two
tables only track the run and its outcomes.

Uniqueness / indexes: `(org_id, created_at)` on `card_import` for listing; unique `(import_id,
row_number)` on `card_import_row` (the idempotency key for a resumed drain, AC-13); an index on
`(outcome)` to find `pending` rows to drain. Submit idempotency: `id` on `card_import` is the client
generated import id, so a repeat submit collides and is treated as the same import (AC-11). Same org
duplicate cards (AC-7) rely on the existing card publish uniqueness, not a column here.

**State transitions**:
`card_import`: `pending` → `processing` (first drain tick picks up its rows) → `completed` (all rows
published) | `completed_with_errors` (some skipped or failed) | `failed` (no row could proceed). The
import settles only when none of its rows remain `pending` or `processing`.
`card_import_row`: `pending` → `processing` (a drain claimed it) → `published` | `skipped` | `failed`.
A row `failed` when its `attempts` reach the bound; a `processing` row older than a reclaim threshold
is returned to `pending` for the next drain (AC-13).

**API surface**:
| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/cards/import` | POST | `importId:uuid` (req), `rows: MappedRow[]` (req) | `importId`, `status`, `total` | member of active org | 400 invalid, 413 too many rows, 429 rate limited |
| `/api/cards/import/[id]` | GET | path `id` | `status`, counts, `rows[]` (row_number, contact_name, outcome, reason, publicUrl) | member, own org | 404 unknown |
| `/api/cron/card-import` | POST | none (drains a bounded batch of `pending` rows across all orgs) | drained/published counts | cron secret (as other `/api/cron/*`) | 401 bad secret |

A `MappedRow` is the already mapped field set for one contact (given name, family name, full name,
title, org, department, email, phones by type, address parts, website), not raw spreadsheet cells.
Parsing, mapping, and preview are entirely in the browser, so there is no server parse endpoint. The
drain route is registered on the companion cron Worker schedule alongside the existing `o365-*` and
`cleanup` jobs.

**Key invariants**:
- Both new tables carry `org_id` and are reached only through `orgDb(orgId)` (rule 1, spec 0002).
- Only the server publishes; the browser sends mapped rows and never writes to a bucket (rule 3,
  spec 0003).
- No row is published without passing the same vCard validation and normalisation as spec 0003.
- When `outcome = published`, `file_id` references a real `files` row; when skipped or failed, it is
  null.
- The counts on `card_import` always equal the tally of its rows' outcomes.
- The publish path used by import does not call the Office 365 sync (AC-12).
- A drain is safe to run concurrently and to re run: a row is claimed atomically (`pending` →
  `processing`), a row already terminal is never touched again, and no row is published twice
  (the `(import_id, row_number)` key plus the existing per org card uniqueness, AC-13).
- Same org duplicate prevention is enforced by the database card uniqueness constraint, never by a
  read then write, so concurrent drains cannot both publish the same person's card (AC-7).

**Security model**: any signed in member of the active organization may run an import, the same tier
that may publish their own single card today; the run is scoped to `session.activeOrganizationId`,
never to anything in the request body. The server re validates every row, so a tampered browser
payload cannot publish an invalid or cross org card. Each published card writes its own publish audit
event (existing), and the import writes a start and a finish audit event naming the actor and the
counts. The feature handles personal data made public: the same compliance posture as spec 0003
applies (deliberate, audited, reversible; imported cards unpublish and delete like any other card).
Rate limited per user per hour and capped per import to bound abuse and cost.

**Configuration required**:
- `MAX_IMPORT_ROWS`: the per import row cap (default 250).
- `IMPORT_RATE_PER_HOUR`: the per user hourly import cap, counting accepted submissions (default 5).
- `CARD_IMPORT_DRAIN_BATCH`: rows published per drain tick (default 20), to stay within Worker limits.
- `CARD_IMPORT_MAX_ATTEMPTS`: attempts before a row is marked `failed` (default 3).
- The companion cron Worker needs the new `/api/cron/card-import` route added to its schedule.

**Critical test scenarios** (each maps to an acceptance criterion in ## Requirements):
- Happy path: upload a three row CSV, map the columns, preview shows three valid, confirm, all three
  publish as cards with public addresses and the report shows three published. Verifies **AC-1**,
  **AC-2**, **AC-3**, **AC-5**, **AC-6**.
- Partial success: a sheet with one nameless row publishes the good rows and reports the bad one
  failed with a readable reason. Verifies **AC-8**.
- Duplicate: a row whose derived slug already exists as a published card in the org is skipped and
  reported, and the existing card is untouched. Verifies **AC-7**.
- Idempotency: re POST the same `importId` and no card is double published, no second import record
  is made. Verifies **AC-11**.
- Crash resume: a drain that stops after publishing some rows of a batch leaves the rest `pending`;
  the next drain finishes them, publishes nothing twice, and the import reaches a terminal report; a
  row that fails `CARD_IMPORT_MAX_ATTEMPTS` times ends `failed`, not looping. Verifies **AC-13**.
- Caps and limits: a sheet over `MAX_IMPORT_ROWS` is refused before processing; the hourly limit
  returns 429. Verifies **AC-9**.
- Auth and tenancy: a signed out visitor is redirected to sign in; rows only ever publish into the
  caller's active organization. Verifies **AC-10**.
- O365 off: in an org with O365 configured, an imported card does not write the CustomAttribute.
  Verifies **AC-12**.

## Build plan

1. Migration for `card_import` and `card_import_row` (with `org_id` leading every index, unique
   `(import_id, row_number)`, an `outcome` index, and `card_import.id` used as the client import id).
   Satisfies **AC-10**, **AC-11**, **AC-13** (storage half).
2. Confirm `publishVcardFromBytes` (already used by the O365 auto provision job) is the shared
   generated vCard publish path; extend only its result so it can report a same org duplicate as
   skipped rather than suffixing. Satisfies **AC-5**, **AC-7** (publish half).
3. Thin end to end slice: `POST /api/cards/import` accepting a small `rows` array, creating the
   import record and its `pending` rows; a `/api/cron/card-import` route that drains one row through
   `publishVcardFromBytes`; and `GET /api/cards/import/[id]` returning the result. One row all the
   way through. Satisfies **AC-5**, **AC-6**.
4. Drain robustness: bounded batch (`CARD_IMPORT_DRAIN_BATCH`), atomic claim (`pending` →
   `processing`), bounded attempts to `failed` (`CARD_IMPORT_MAX_ATTEMPTS`), reclaim of stale
   `processing` rows, and safe no op on an already terminal row. Satisfies **AC-6**, **AC-13**.
5. Duplicate handling: same org derived slug already published → skip and report; a different org's
   slug follows spec 0003's suffix rule; enforced by the card uniqueness constraint, not a read then
   write. Satisfies **AC-7**.
6. Browser import flow, part one: file picker, browser side parsing (a small CSV parser, and a
   dynamically imported `.xlsx` parser so it is not in the initial bundle), and the interactive
   column mapping screen. Satisfies **AC-1**, **AC-2**.
7. Browser import flow, part two: the preview with per row validation and a confirm gate; on confirm
   send only the mapped rows as JSON, never the raw file. Satisfies **AC-3**, **AC-4**.
8. Server row validation and vCard build reuse (partial success with a per row reason), plus the row
   cap and the per user hourly submission rate limit, all before any row is stored. Satisfies
   **AC-5**, **AC-8**, **AC-9**.
9. Idempotency on the client import id (a repeat submit returns the existing import, no second
   record). Satisfies **AC-11**.
10. Tenant scoping through `orgDb`, start and finish audit events, and a guard that the import
    publish path does not trigger the O365 sync. Satisfies **AC-10**, **AC-12**.
11. Progress and results UI polling `GET /api/cards/import/[id]`, the import surfaced in Activity,
    and a nightly purge of old import records on the existing cleanup cron. Satisfies **AC-6** (and
    the retention follow up).
12. Tests: unit (row to vCard mapping, validation, slug skip), integration against real bindings
    (drain publish, partial success, crash resume, idempotency), and a Playwright run of upload, map,
    preview, confirm, results. Covers every acceptance criterion.

## Consequences

**Positive**:
- Staff publish a whole team's cards in one pass instead of one at a time.
- Reuses the existing `publishVcardFromBytes` path and vCard builder rather than duplicating them,
  and reuses the live companion cron drain pattern rather than adding new infrastructure.
- The spreadsheet parser never ships in the Worker bundle, and the raw personal data never reaches
  R2.

**Negative / tradeoffs**:
- The server must fully re validate untrusted rows; the browser preview cannot be a shortcut.
- The `.xlsx` parser adds weight to the client bundle (mitigated by loading it only when an `.xlsx`
  file is chosen).
- Publishing is not instant: rows complete over successive cron ticks, so a large import finishes
  gradually rather than at confirm time.
- Any member can now publish many people's personal data at once, a broader reach for a privileged
  feeling action than single card publishing; audit events and the rate limit are the checks on it.

**Neutral**:
- A new drain route on the companion cron schedule, plus the `attempts`/reclaim bookkeeping for
  resumability.
- A new migration and a retention purge for import records on the existing cleanup cron.

## Follow-up

- [ ] Decide the retention window for import records (proposed about 90 days) and wire the purge into
      the existing nightly cron.
- [ ] Offer a downloadable results report (CSV) for larger imports.
- [ ] Provide a downloadable column template to speed up mapping for common spreadsheets.
- [ ] Revisit whether bulk import should later be restricted to admins and owners if member run bulk
      publishing proves too broad in practice.
- [ ] A Cloudflare Workers / Wrangler and Drizzle skill would help this build (already noted project
      wide in the spec 0001 follow up list).
- [ ] If import volume ever outgrows a bounded per tick cron drain, stand up a real Cloudflare Queue
      (the `queues` block is currently commented out in `wrangler.jsonc`) and move publishing onto it.
