# 0030. Per visitor engagement analytics for cards

**Date**: 2026-09-10
**Status**: Accepted

Extends [0008](0008-public-card-landing-and-analytics.md) (public card landing and view/scan/download analytics) and [0009](0009-host-based-card-page-access.md) (public host only counting).

## Summary

Today a card's engagement is only aggregate counts: how many views, scans, downloads, and PDF
saves it got each day (spec 0008). Admins want to know more about the actual people engaging with a
card. This spec adds a per visit record: on every counted public hit we store one event with the
visitor's external IP address, their location and network (from Cloudflare), their device and
browser, the referrer, and the metric. Owners and admins get a new Analytics tab under Activity Logs
that lists these visits and an approximate unique visitor count. The raw visit rows are kept for 12
months and then purged; the existing daily counts are untouched and kept forever. Because this stores
personal data about outside visitors, the raw detail is owner and admin only, and the (currently
dead) footer Privacy link now points to a real Privacy page.

## Context

Spec 0008 records engagement as a daily rollup in `card_stat_daily`: one row per card, per day, per
metric, incremented with an UPSERT on each counted public hit. That answers "how much" but nothing
about "who". The counting happens in the public serving route (`src/app/c/[slug]/route.ts`), which
already runs on the app Worker and fires `recordCardHit` after the response via `ctx.waitUntil`. That
route is exactly where a visitor's request metadata is available, so capturing more is a small
addition at a point that already exists.

Two forces shape the design. First, this is personal data about external people (an IP address plus
derived location is personal data under GDPR and CCPA), on pages that are public and viewed by people
outside the company. That pulls in access control (admin only), a bounded retention window, and a
visible privacy notice. Second, the platform runs on Cloudflare, where the rich visitor location and
network fields come from Cloudflare's own `request.cf` object at no cost, and the traffic is internal
scale (staff cards, not a consumer product), so a plain D1 table beside the existing rollup is enough
and needs no new infrastructure.

One capability is deliberately ruled out: a visitor's internal or private IP address (for example
`192.168.x.x`) cannot be captured. A device behind NAT never sends its private address to a web
server, and there is no header for it. Only the public/external IP is available.

## Requirements

**User stories**:
- As an owner or admin, I want to see the people engaging with our cards (where they are, what device
  and network they use, and when), so that I understand who our cards reach, not just how often.
- As an owner or admin, I want an approximate count of unique visitors, so that I can tell "many hits
  from one person" apart from "many people".
- As a compliance minded operator, I want visitor detail to be admin only, kept for a bounded time,
  and disclosed on a privacy page, so that storing outside visitors' personal data is controlled and
  transparent.
- As a member, I want my existing per card counts to keep working unchanged, so that this change does
  not remove what I already rely on.

**Acceptance criteria** (the contract):
- **AC-1**: On each counted public hit (a landing view, a `?src=qr` scan, a `.vcf` download, or a
  `.pdf` save), one `card_visit_event` row is written recording the metric, the time, the external IP
  (`CF-Connecting-IP`), the location and network available from Cloudflare's request metadata (country,
  region, city, postal, coarse latitude/longitude, timezone, ASN, network organization), the raw
  User-Agent, the referrer, and the `src`. Device/OS/browser are derived from the stored User-Agent at
  read time, not stored. Fields that are unavailable are stored null.
- **AC-2**: The same bot and link preview User-Agent filter that governs the counts (spec 0008 AC-4)
  governs events: a non countable request records neither a count nor a visit event, so the event log
  and the aggregate totals always agree.
- **AC-3**: Recording a visit event never blocks, slows, or fails the response. It runs after the
  response (`waitUntil`) and a write error is swallowed, the same best effort guarantee as the counts
  (spec 0008 AC-5).
- **AC-4**: Only real public host traffic is recorded. An app host (`www`) hit is a signed in staff
  preview and records no event and no count, exactly as with the existing counts (spec 0009).
- **AC-5**: An approximate unique visitor count is derived from a stored salted hash of IP + User-Agent
  + day (salted with a server secret `IP_HASH_SALT`). It groups repeat hits without re reading the raw
  IP, and the salt keeps the hash from being rehashable against guessed IPs if the raw `ip` column is
  ever redacted later. It is a grouping key, not a confidentiality measure (an admin sees the raw `ip`
  on the same row).
- **AC-6**: An owner or admin can view an org wide visitor feed in a new Analytics tab under Activity
  Logs: events newest first, paginated, filterable by card and by metric, each showing the card, the
  metric, the time (Eastern, matching Activity Logs), the IP, the resolved location, the network, the
  device/browser, and the referrer, plus the unique visitor count for the current filter.
- **AC-7**: The visitor feed and its API are owner and admin only; a member receives 403 and does not
  see the Analytics tab. Members keep the existing aggregate card stats for their own cards unchanged.
- **AC-8**: Every visit read and write is scoped to the active organization through `orgDb`, so one
  organization can never see or record another's visitor events.
- **AC-9**: Raw `card_visit_event` rows are retained 12 months, or until their card is hard deleted
  (the `file` FK removes them with the card), whichever comes first. The nightly cron purges rows past
  the 12 month cutoff in bounded batches. The aggregate `card_stat_daily` rollup is never purged here.
- **AC-10**: The migration is additive (`CREATE TABLE` plus indexes only) and never rebuilds `file` or
  any existing table, so it cannot cascade delete existing rows (the platform migration gotcha).
- **AC-11**: The footer Privacy link (currently a dead `#`) points to a Privacy page reachable without
  signing in, describing what visitor data is collected, why, and the retention period.

## Options considered

The controls (per visitor capture, an admin feed, unique counts) and the load bearing choices (full
IP, admin only, 12 month retention) were settled with the engineer. Two design choices remained: where
to store the events, and whether to keep the existing rollup.

### Option 1: A D1 event table beside the existing rollup (recommended)

Add an append only `card_visit_event` table in D1. Write one row per counted hit from the existing
public route, alongside (not replacing) the `card_stat_daily` UPSERT. Reads go through the org scoped
`orgDb` wrapper like every other tenant table.

**Pros**:
- Fits the existing pattern exactly: org scoped reads, joins to `file`/`org` rows, role based access,
  ordinary SQL for the admin feed and the unique count. No new infrastructure or binding.
- The aggregate rollup stays the fast path for totals and trends; the event table adds detail without
  slowing the existing Files/Dashboard reads.
- Retention is a simple dated delete in the nightly cron.

**Cons**:
- One extra D1 write per counted public hit (best effort, off the response path, so it cannot slow a
  response), and the table grows with traffic (bounded by the 12 month purge).

### Option 2: Cloudflare Analytics Engine for the raw events

Write each event to a Cloudflare Analytics Engine dataset and query it through its SQL API; keep D1
only for the rollup.

**Pros**:
- Built for very high write volume and time series, with sampling handled for you.

**Cons**:
- Weak joins to D1 rows (card names, org, uploader), harder per organization access control, roughly
  90 day retention, and query sampling. All of that fights the admin feed we actually want.
- A second store and query path to operate, for volume this product does not have (staff cards).

### Option 3: Both, rollup in D1 and raw events in Analytics Engine

Keep counts in D1, stream raw events to Analytics Engine.

**Pros**:
- Would scale to far higher volume than D1 alone.

**Cons**:
- Two stores and two query paths to keep in sync, for no benefit at this scale; the admin feed still
  needs the D1 joins and per org scoping that Analytics Engine makes awkward.

## Decision

**Chosen option**: Option 1: an append only `card_visit_event` table in D1, written from the existing
public route beside the current rollup, read through `orgDb`, surfaced to owners and admins as an
Analytics tab under Activity Logs, and purged after 12 months by the nightly cron.

**Implementation skills**: `tailwindcss-v4` (`.claude/skills/tailwindcss-v4/`) · `frontend-design` (`.claude/skills/frontend-design/`) · `playwright` (`.claude/skills/playwright/`)

## Rationale

The platform's rule is reuse over sprawl, and the counting hook already exists at the one place a
visitor's request metadata is available (the public route's `waitUntil` call). Adding one D1 insert
there, beside the rollup, reuses the entire existing toolbox (org scoping through `orgDb`, joins to
the card and org rows, the same role logic, the nightly cron) and needs no new binding. Analytics
Engine (Options 2 and 3) is the right tool at consumer scale, but here it would trade the joins,
per organization access control, and open retention we need for scale we do not have; the honest cost
of Option 1, one extra best effort write per hit and a growing table, is bounded by the 12 month purge
and never touches the response path.

Storing the full external IP (rather than a truncated or hashed form) follows the engineer's aim of
maximum admin insight for an internal tool; the privacy cost of that is answered by controls, not by
degrading the data: the raw detail is owner and admin only, it is purged after 12 months, the
`visitor_hash` is salted, and the collection and its legitimate interest basis are disclosed on a
Privacy page. The existing rollup is kept because it is the cheap, never expiring source for the
totals and trends the Files page and Dashboard already draw; the event table is a detail layer beside
it, not a replacement, so nothing that works today regresses.

Two smaller calls. The geo and network fields are stored as typed columns rather than a single raw
`cf` JSON blob, because they are displayed, exportable, and feed a possible map view; the cost is that
adding a future `cf` field needs a migration, which is acceptable. And device/OS/browser are derived
from the stored raw `User-Agent` at read time rather than persisted, so an improved parser applies to
old rows and no stale heuristic output is frozen in.

## Feature design

**Data model sketch**:

New table `card_visit_event` (additive migration, `CREATE TABLE` + indexes only, never a rebuild):

| Field | Type | Notes |
|---|---|---|
| `id` | text, PK | uuidv7 (time sortable) |
| `org_id` | text, not null | tenant scope; every index leads with it (platform rule); FK `organization(id)` |
| `file_id` | text, not null | the card's file row; FK `file(id)` |
| `metric` | text, not null | one of `view`, `scan`, `download`, `pdf` (mirrors `card_stat_daily`) |
| `created_at` | integer (timestamp_ms), not null | event time |
| `ip` | text, nullable | full external IP (`CF-Connecting-IP`) |
| `visitor_hash` | text, nullable | salted hash of IP + User-Agent + UTC day (server secret `IP_HASH_SALT`); a grouping key for unique counting (AC-5) |
| `country` | text, nullable | `cf.country`, or the `CF-IPCountry` header fallback |
| `region` | text, nullable | `cf.region` |
| `city` | text, nullable | `cf.city` |
| `postal` | text, nullable | `cf.postalCode` |
| `latitude` | real, nullable | `cf.latitude` (coarse) |
| `longitude` | real, nullable | `cf.longitude` (coarse) |
| `timezone` | text, nullable | `cf.timezone` |
| `asn` | integer, nullable | `cf.asn` |
| `as_org` | text, nullable | `cf.asOrganization` (ISP / company network) |
| `user_agent` | text, nullable | raw `User-Agent` header; device/OS/browser are DERIVED from this at read time, not stored (so an improved parser applies to old rows) |
| `referrer` | text, nullable | `Referer` header |
| `src` | text, nullable | landing source, e.g. `qr` |

- No primary key beyond `id`; this is an append only log (contrast the rollup's composite key). Every
  row is a distinct event, so there is no UPSERT.
- Indexes (all lead with `org_id`): `(org_id, created_at)` for the newest first feed, `(org_id,
  file_id, created_at)` for a per card filter, `(org_id, metric, created_at)` for the metric only
  filter (AC-6), and `(org_id, visitor_hash)` for unique tallies.
- No new columns on `file`. `card_stat_daily` is unchanged.
- Retention: 12 months for these rows (AC-9); the `card_stat_daily` rollup is kept indefinitely
  (spec 0008). On hard file delete, a row's `file_id` FK removes it with the file, matching the
  existing card stat behavior.

**Effective capture** (in the existing public route, on the same `waitUntil` as the count):
- Read Cloudflare's request metadata via `getCloudflareContext().cf` (the incoming request's cf
  properties under OpenNext, not `request.cf`, which OpenNext does not reliably preserve), with the
  always present `CF-Connecting-IP` and `CF-IPCountry` headers as the fallback. Store the external IP,
  the `cf` geo/network fields, the raw `User-Agent`, the `Referer`, and the `src`. Device/OS/browser
  are NOT stored; they are derived from the stored `User-Agent` at read time (a lightweight in house
  heuristic, the same style as the bot list), so an improved parser applies to old rows.
- `visitor_hash = hash(IP_HASH_SALT + ip + "|" + userAgent + "|" + utcDay)`; a salted grouping key for
  unique counting, not confidentiality (the raw `ip` is on the same row for admins), but the salt keeps
  it from being rehashable against guessed IPs if `ip` is ever redacted later.
- Recorded only when `isCountableUserAgent` is true and only on the public host, so events and counts
  stay in lockstep (AC-2, AC-4). Best effort, never thrown (AC-3).

**API surface**:

| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/analytics/visitors` | GET | `cursor` (opt), `limit` (opt), `fileId` (opt), `metric` (opt), `range` (opt days) | events (newest first) + `nextCursor` + `uniqueVisitors` for the current filter | owner or admin of the active org | 401, 403 (member) |
| `/activity` Analytics tab | page | — | the feed UI (owner/admin only) | owner or admin | renders 403/empty for members |
| `/privacy` | GET | — | public Privacy page HTML | public (no session) | — |
| public `/c/<slug>` and `/c/<slug>.vcf`/`.pdf` (existing) | GET | existing | unchanged responses; now also record a visit event | public | unchanged |

- The feed is keyset paginated (cursor `<createdAtMs>.<id>`), matching the Activity Logs feed
  (spec 0018) so the tab reads consistently.
- Purge is a nightly cron job (a cross org system delete by `created_at`, like the existing cleanup
  sweep), not an API.

**Key invariants**:
- A visit event is recorded only for a slug that resolves to a currently published file, always under
  that file's own `org_id` (resolved server side from the slug, never from the request), and only on
  the public host for a countable User-Agent.
- One event row is written per counted hit, on the same best effort path as the rollup UPSERT. Events
  are approximate engagement signals, not a reconciled ledger: a retried or dropped `waitUntil` can
  make the event count drift slightly from the rollup cell, and rows purged at 12 months or on card
  delete leave the (never purged) rollup ahead. Neither number is an audited figure (as in spec 0008).
- Recording is best effort and never on the response's critical path.
- Every visit read and write goes through `orgDb(orgId)`; the cross org purge is the one system wide
  operation and writes nothing per request.

**Security model**:
- The raw visitor detail is personal data, so the feed and `/api/analytics/visitors` are owner and
  admin only (`requireApiRole("admin")`); a member gets 403 and never sees the Analytics tab. Members
  keep the existing aggregate stats for their own cards (spec 0008 scoping is unchanged).
- Reads are org scoped through `orgDb`; the acting org is resolved from the session, never the request.
- Retention (12 months), the salted `visitor_hash`, and the Privacy page are the minimization and
  disclosure controls for storing outside visitors' IP and location. Compliance scope: general
  personal data handling (GDPR/CCPA hygiene), not a special category.
- Lawful basis for processing EU/UK visitors' IP and coarse location is legitimate interest
  (understanding engagement with the company's own published business cards); the Privacy page states
  this and names a contact address for access or deletion requests. Visitors have no account, so a
  data request is handled manually by an admin; the 12 month purge and the card delete cascade already
  bound how long any row lives.

**Configuration required**:
- `IP_HASH_SALT`: a server secret (set once via `wrangler secret`) salting `visitor_hash`. Do not
  rotate it casually; rotating makes unique counts before and after incomparable.
- Retention is a code constant (12 months); make it env overridable per the config over hardcoded
  convention if a value is likely to change.
- Cloudflare metadata is read via `getCloudflareContext().cf` under OpenNext. A quick pre build spike
  confirms the exact access path, since the codebase has no existing `cf`/`request.cf` usage. The
  always present `CF-Connecting-IP` and `CF-IPCountry` headers are the fallback; if `cf` is
  unavailable the richer geo/network fields are null and the feature degrades to IP + country. Emit a
  one time log/health signal when `cf` is absent, so a silently broken path (all geo null) is caught
  early rather than months later.

**Critical test scenarios** (each maps to an acceptance criterion):
- Happy path: a public host view / `?src=qr` scan / `.vcf` download / `.pdf` save each writes one
  event with the metric and the available IP, geo, network, device, and referrer fields. Verifies
  **AC-1**.
- Bot filter: a request with a bot/link preview User-Agent writes neither an event nor a count.
  Verifies **AC-2**.
- Best effort: with the event insert forced to throw, the page and file still return 200 with correct
  content. Verifies **AC-3**.
- App host: a signed in `www` preview writes no event. Verifies **AC-4**.
- Unique count: two hits from the same IP + User-Agent on the same day count as one unique visitor;
  a third from a different IP makes two. Verifies **AC-5**.
- Authorization: a member gets 403 from `/api/analytics/visitors` and sees no Analytics tab; an owner
  and an admin see the org wide feed. Verifies **AC-6**, **AC-7**.
- Tenancy: organization A's feed never returns organization B's events. Verifies **AC-8**.
- Retention: an event dated older than 12 months is removed by the purge; a rollup row is not.
  Verifies **AC-9**.
- Migration safety: the generated SQL is `CREATE TABLE`/`CREATE INDEX` only, no `DROP TABLE`. Verifies
  **AC-10**.
- Privacy link: the footer Privacy link loads `/privacy` while signed out. Verifies **AC-11**.

## Build plan

Ordered as end to end tracer bullet slices (no build approach on record, so end to end assumed): stand
up capture through to a visible admin feed first, then retention, then the privacy surface. The
additive migration is task 1 and the two visitor touching surfaces (capture, feed) come before the
peripheral privacy page.

1. Additive migration: create `card_visit_event` with its three `org_id` leading indexes and the
   `file`/`organization` FKs; confirm the generated SQL is create only, no table rebuild. Satisfies
   **AC-1** (storage), **AC-10**.
2. Capture in the public route: first pin the Cloudflare metadata access path
   (`getCloudflareContext().cf` vs `request.cf`) with a quick spike, since nothing in the repo uses it
   yet. Then extend the existing `waitUntil` counting path to also write one visit event, gathering the
   external IP (`CF-Connecting-IP`), the `cf` geo/network fields (with the `CF-IPCountry` header
   fallback and a health log when `cf` is absent), the raw `User-Agent` and `Referer`, the `src`, and
   the salted `visitor_hash` (needs the `IP_HASH_SALT` secret); recorded only for a countable
   User-Agent on the public host; best effort, never thrown. Add the `orgDb().visits.record` helper.
   Satisfies **AC-1**, **AC-2**, **AC-3**, **AC-4**, **AC-5**, **AC-8**.
3. Visitor read helpers in `orgDb`: `visits.listPage` (keyset, filter by `fileId`/`metric`/`range`) and
   `visits.uniqueCount` (`COUNT(DISTINCT visitor_hash)` over the same filter), org scoped. Satisfies
   **AC-6**, **AC-8**.
4. Admin feed + Analytics tab: `GET /api/analytics/visitors` (owner/admin, org scoped, filters, unique
   count) and a new Analytics tab under Activity Logs rendering the feed (Eastern timestamps, newest
   first, paginated), deriving device/OS/browser from each row's stored `User-Agent` at render, hidden
   from members. Satisfies **AC-6**, **AC-7**.
5. Retention purge: add a new bearer authenticated `/api/cron/*` endpoint AND register it in the
   standalone cron Worker's `scheduled()` handler (the repo's two part cron pattern, see
   `cron/src/index.ts`), deleting `card_visit_event` rows past the 12 month cutoff across orgs in
   bounded batches (self chaining like the spec 0028 drain if a run is large), leaving
   `card_stat_daily` untouched. Satisfies **AC-9**.
6. Privacy page + footer link: a public `/privacy` page describing the visitor data collected, its
   purpose, the legitimate interest basis, the 12 month retention, and a contact address for access or
   deletion requests (a content skeleton; the final policy copy is company supplied), and repoint the
   footer Privacy link to it. Satisfies **AC-11**.
7. Tests: capture field mapping, bot filter exclusion, best effort never throws, app host records
   nothing, unique count math, owner/admin gate (member 403), org scoping, purge cutoff, and the
   create only migration. Satisfies **AC-2** through **AC-10**.

## Consequences

**Positive**:
- Admins see who engages with cards (location, network, device, referrer, time) and an approximate
  unique visitor count, not just aggregate hits, all in one org wide feed under Activity Logs.
- Reuses the existing counting hook, `orgDb` scoping, role logic, and nightly cron; one new table, no
  new infrastructure. The aggregate rollup and existing member facing stats are untouched.
- The (previously dead) footer Privacy link now leads to a real page.

**Negative / tradeoffs**:
- The app now stores personal data about outside visitors (full IP + location). This is mitigated by
  admin only access, a 12 month purge, and the Privacy page, but it is a real new obligation to honor.
- One extra best effort D1 write per counted public hit, and a table that grows with traffic (bounded
  by the purge). Never on the response path, but more writes than the rollup alone.
- Visitor detail depends on Cloudflare's request metadata (`getCloudflareContext().cf`); if it is
  unavailable the richer geo/network fields are null and the feed degrades to IP + country (a health
  log flags this so it is not discovered silently).
- Device/OS/browser are a lightweight heuristic over the User-Agent, and the unique visitor count is
  an estimate (no login; a shared IP or a cleared client blurs it), so both are approximate.
- External visitors cannot self serve data rights (no account); access or deletion requests are
  handled manually by an admin, bounded by the 12 month purge and the card delete cascade.

**Neutral**:
- One new additive D1 table and migration; no change to existing tables.
- A new public `/privacy` route joins the existing public surface (card landing, logos).
- The Analytics tab is a new owner/admin surface under the existing Activity Logs page.

## Follow-up

- [ ] Company/legal to supply the actual Privacy page copy, confirm the stated legitimate interest
      basis, and provide the data request contact address (the build ships a structured skeleton).
- [ ] Decide whether a targeted per visitor delete tool is worth building for an individual data
      request (today: manual, and bounded by the 12 month purge and the card delete cascade).
- [ ] Deferred by choice for 0030: a per card visitor drill down (org wide feed only for now) and CSV
      export of visitor data. Revisit if admins ask.
- [ ] Consider a visitor map view (the coarse latitude/longitude is captured but not yet visualized).
- [ ] If `card_visit_event` ever grows large despite the purge, revisit a rollup of the detail or
      moving raw events to Analytics Engine (Option 2).
