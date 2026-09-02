# 0008. Public card landing page and view/scan/download analytics

**Date**: 2026-09-01

## Summary

Today a published contact card serves as a bare `.vcf` file straight from R2 (object storage), and nobody can see how often a card is used. This spec adds two things. First, a small styled public web page for each card (name, title, phones you can tap to call, email, address, social links, and an "Add to contacts" button that downloads the `.vcf`). Second, per card counts of three things: page views, QR scans, and `.vcf` downloads, shown to staff on the Files page and the Dashboard. To make both possible, the public address `contacts.awvcard.com` moves from being served directly by R2 to being served by the existing app Worker, which can render the page and record a count. Every already printed QR code and email signature keeps working unchanged, because the exact `.vcf` address stays the same.

> ⚠️ Premise note: this puts the app Worker in the critical path for resolving public cards, which R2 served on its own before (very hard to knock over). A bad app deploy could now take public cards down, and counting on every request means we cannot let Cloudflare cache the counted responses at the edge. We accept this because a landing page and live in app counts both require a Worker in the path, and we cut the risk three ways: the public path is kept dependency light, counting never blocks or fails a response (it runs after the response via `waitUntil`), and the domain rebind is one config change to roll straight back to R2. A fully passive alternative (Cloudflare log based download counts, no Worker) is Option 3 below and was rejected because it gives no landing page and no live in app numbers.

## Context

Published `.vcf` cards resolve at `https://contacts.awvcard.com/c/<slug>.vcf`. That hostname is an R2 bucket custom domain: Cloudflare serves the object directly and no code runs, so there is nowhere to render HTML or record a hit. `publicUrlFor` in `src/server/uploads.ts` builds that address; the printed QR codes on business cards and the QR in every email signature encode it verbatim, so the address cannot change.

Staff have no idea whether a card is ever opened. They want to know how many times each card's page was viewed, how many times its QR was scanned, and how many times the contact was actually saved (the `.vcf` downloaded). A raw `.vcf` is also a poor thing to hand a person: opened in a browser it just downloads a file, with no name, photo, tap to call, or social links.

Forces at play: the platform already runs entirely on Cloudflare (Next.js on Workers, D1 for records, R2 for files), so the cheapest path reuses that stack rather than adding new infrastructure. The public address must not change. The public data is real people's personal contact details, so the page must stay out of search engines (the `contacts` domain already carries a `noindex` rule). Traffic is internal scale (staff cards, not a viral consumer product), so the counting store does not need to handle millions of writes per second. And the app is live in production, so any change to how public cards resolve must be reversible and provably safe before it goes live.

## Requirements

**User stories**:
- As a person who scans a colleague's QR code, I want a clean page with their details and a one tap "Add to contacts", so that saving them is easy on my phone.
- As a staff member, I want to see how many times my card was viewed, scanned, and saved, so that I know it is working and worth sharing.
- As an owner or admin, I want to see engagement across all of the org's cards, so that I can see which cards get used.
- As an operator, I want the switch to the new serving path to be reversible, so that a problem never leaves public cards down.

**Acceptance criteria** (the contract):
- **AC-1**: `GET https://contacts.awvcard.com/c/<slug>.vcf` returns the same vCard bytes and `text/vcard` content type as before the change, for every currently published slug. Existing QR codes and signatures resolve unchanged.
- **AC-2**: `GET https://contacts.awvcard.com/c/<slug>` (no `.vcf`) returns a styled HTML page for a published card, showing name, title, organization, phone(s) as `tel:` links, email as a `mailto:` link, address (with a map link), the org's social links for that card's state, and an "Add to contacts" button linking to the `.vcf`. The page needs no client side JavaScript to function.
- **AC-3**: A landing page load records one **view**. A load with `?src=qr` records one **scan** (and is not double counted as a plain view). A `.vcf` fetch records one **download**. Counts are per card and per day.
- **AC-4**: Requests from known bot and link preview user agents (Apple, Google, Slack, WhatsApp, Facebook, Twitter/X, LinkedIn, Discord, and similar) do not increment any count.
- **AC-5**: Recording a count never blocks, slows, or fails the response. If the count write errors, the page or file is still served normally.
- **AC-6**: An unpublished or unknown slug returns 404 from both the landing route and the `.vcf` route, and records no count. Unpublishing a card later does not delete its historical counts.
- **AC-7**: The Files page shows each card's view, scan, and download totals (and last activity day) on its row, respecting existing role scoping (owner/admin see the whole org; members see their own). A per card view shows a daily trend.
- **AC-8**: The Dashboard shows an org level engagement panel: total views/scans/downloads and a "top cards" list, org wide for owner/admin and own only for members.
- **AC-9**: New QR codes and email signatures encode the landing address with `?src=qr`; the `.vcf` fallback still works if a scanner opens it directly.
- **AC-10**: Both public responses (landing and `.vcf`) carry `X-Robots-Tag: noindex, nofollow`, preserving the current search engine exclusion after the domain moves onto the Worker.
- **AC-11**: The counting migration is purely additive (a new table plus indexes) and never rebuilds an existing table, so it cannot cascade delete any existing rows (see the platform's migration gotcha).

## Options considered

### Option 1: App Worker owns the contacts domain, counts in D1

Move `contacts.awvcard.com` from the R2 custom domain onto the existing Next.js app Worker as a second custom domain. The Worker serves the landing HTML at `/c/<slug>`, streams the R2 object at the unchanged `/c/<slug>.vcf`, and records counts into a D1 daily rollup table. Reuses everything already in the app: `parseVcard`, the signature brand config, `resolveSocials`, the R2 helpers, D1/Drizzle, and the org data layer.

**Pros**:
- One deploy, one codebase, no new infrastructure to operate; reuses parsing, branding, and storage code that already exists.
- The unchanged `.vcf` address keeps every printed QR and signature working, now counted.
- Counts live in D1 next to the file rows, so the Files page and Dashboard read them with ordinary queries and existing role scoping.

**Cons**:
- Puts the app Worker in the path for public card resolution (see Premise note); an app outage now affects public cards.
- Counting means the counted responses cannot be edge cached, so every hit reaches the Worker (tiny payloads, so acceptable).

### Option 2: A separate dedicated public Worker

A small standalone Worker (like the existing cron worker) owns `contacts.awvcard.com`, with its own R2 and D1 bindings, and does only the public serving and counting.

**Pros**:
- Isolates public serving from the app: an app deploy cannot break public cards, and the public surface has no session/auth code at all.
- The public path can be tuned and deployed on its own cadence.

**Cons**:
- Duplicates vCard parsing, branding, social resolution, slug lookup, and R2 access into a second codebase, or forces extracting them into a shared package now; real ongoing maintenance cost for a small team.
- The in app Dashboard/Files still read the same D1, so the split buys isolation at the price of two deployables that must stay in sync.

### Option 3: Keep R2 direct, count downloads passively, land on a side route

Leave the `.vcf` on the R2 custom domain untouched. Get download counts from Cloudflare's own request logs (Logpush or the GraphQL analytics API) rather than from code, and put the landing page on a separate app route or subdomain that new QRs point to.

**Pros**:
- Lowest risk to the current `.vcf` availability: R2 keeps serving files directly, no Worker in that path.
- No counting code on the download path.

**Cons**:
- No live in app numbers: log based counts are delayed, coarse, external to D1, and awkward to break down per card and per org.
- Legacy QRs that hit the `.vcf` directly get no landing page and no view/scan distinction, so the feature only half exists for cards already in the wild.

## Decision

**Chosen option**: Option 1: the app Worker owns `contacts.awvcard.com` and records counts into a D1 daily rollup.

The existing Next.js app Worker takes over the `contacts.awvcard.com` custom domain and serves both the new landing page (`/c/<slug>`) and the unchanged download (`/c/<slug>.vcf`), recording view/scan/download counts into a new additive D1 table. The domain rebind is the last, isolated, reversible step, after the routes are built and verified on the existing `www` host.

**Implementation skills**: `frontend-design` (`.agents/skills/frontend-design/`) · `tailwindcss-v4` (`.agents/skills/tailwindcss-v4/`) · `playwright` (`.agents/skills/playwright/`)

## Rationale

The platform's own rule is reuse over sprawl, and Option 1 reuses the entire existing toolbox (parsing, branding, social resolution, R2, D1, role scoping) in one deploy, which a small team can actually operate. Option 2's isolation is attractive given the "do not break the app" constraint, but the price is a second codebase duplicating the card parsing and branding that this feature leans on heavily, and the Dashboard still reads the same D1 anyway, so the isolation is partial while the maintenance cost is real. We answer the same availability worry more cheaply: keep the public path dependency light, make counting fire and forget so it can never break a response, and keep the R2 rebind one config change from rollback.

Option 3 is the safest for the raw `.vcf`, but it cannot deliver the two things actually asked for: a real landing page and live per card numbers in the app. Its passive download counts are delayed and live outside D1, and cards already in the field would never get a landing page. Since a landing page needs a Worker in the path regardless, once we are paying that cost the marginal work to also count in D1 is small, and it keeps all the data in one queryable place.

On the counting store, a daily rollup in D1 (one row per card, per day, per metric, incremented with an UPSERT) keeps growth bounded, survives concurrent hits atomically, and feeds the same kind of per day chart the Dashboard already draws, without a new binding or a separate query API. We deliberately do not store per card total columns on the file row: derived totals drift from their source and would have to be kept in sync on every hit; instead the Files page aggregates totals for just the rows on the current page (a single grouped query over an indexed table), which is cheap at the page's keyset pagination size and never goes stale.

## Feature design

**Data model sketch**:

New table `card_stat_daily` (additive migration, `CREATE TABLE` + indexes only, never a table rebuild):

| Field | Type | Notes |
|---|---|---|
| `org_id` | text, not null | tenant scope; every index leads with it (platform rule) |
| `file_id` | text, not null | the card's file row id; references `file(id)` |
| `date` | text, not null | `YYYY-MM-DD` (UTC) of the activity |
| `metric` | text, not null | one of `view`, `scan`, `download` |
| `count` | integer, not null, default 0 | hits that day for that metric |

- Primary key: composite (`file_id`, `date`, `metric`) so an UPSERT increments exactly one row.
- Indexes: (`org_id`, `date`) for org wide Dashboard rollups; (`org_id`, `file_id`) for per card reads within an org.
- No new columns on `file` (no denormalized totals, by decision above).
- Retention: keep indefinitely (small, bounded); rows are tied to `file_id` and survive unpublish. On hard file delete the rows are removed with the file.

**State transitions**: none new. Counting applies only while a card is `public`/published; unpublishing makes both public routes 404 but retains historical rows.

**API surface**:

| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/c/<slug>` (on contacts host) | GET | slug (path), `src` (opt, `qr`) | HTML landing page; records view or scan | public | 404 unknown/unpublished slug |
| `/c/<slug>.vcf` (on contacts host) | GET | slug (path) | `text/vcard` bytes; records download | public | 404 unknown/unpublished slug |
| `/api/files` (existing) | GET | existing params | existing rows + `views`/`scans`/`downloads`/`lastActivity` per row | session, org scoped | 401 |
| `/api/cards/[id]/stats` | GET | id (path), range (opt) | totals + daily series for the card | session, org scoped (own or manage) | 401, 403, 404 |
| dashboard data (existing loader) | server | — | + engagement totals + top cards + trend | session, role scoped | — |

Recommended route shape (final layout left to `/develop`): a single public GET handler under `/c/` on the contacts host that branches on the `.vcf` suffix (stream + count download) versus no suffix (render landing + count view/scan). The landing is a self contained inline styled HTML string (the pattern already used by `src/lib/signature-html.ts`), so it needs no Tailwind bundle or client hydration and renders identically wherever it is opened. Counting runs after the response is sent (`waitUntil`/`after`), wrapped in try/catch.

**Key invariants**:
- The `.vcf` bytes and content type are identical before and after the domain move (AC-1).
- Exactly one metric row is incremented per counted hit; an UPSERT (`ON CONFLICT(file_id,date,metric) DO UPDATE SET count = count + 1`) makes concurrent hits safe.
- A count is only ever recorded for a slug that resolves to a currently published file, and always under that file's own `org_id` (looked up server side from the slug, never from the request).
- Counting is best effort and never on the response's critical path.
- Both public responses carry `X-Robots-Tag: noindex, nofollow`.

**Security model**:
- Public routes are unauthenticated, read only, and expose only data that is already public (the published vCard). No session, no cookies, no mutation of user data; the only write is an increment on an internal counter keyed by the resolved file. Counts are best effort and could be inflated by a determined actor hitting the URL; acceptable for internal engagement analytics, noted as a tradeoff. Cloudflare's platform absorbs volumetric abuse; bot filtering removes the routine prefetch inflation.
- In app stats reads go through the org scoped data wrapper (`orgDb`) and mirror the existing rail/dashboard role scoping: owner/admin see org wide, members see their own cards only. Viewing a card's stats does not require manage rights, only ownership or an admin role.

**Configuration required**:
- No new secrets. The domain rebind is a `wrangler.jsonc` change: add `contacts.awvcard.com` as a custom domain on the app Worker (removing it from the R2 bucket). The current Cloudflare `noindex` transform rule on the domain is superseded by the Worker emitting the header itself (AC-10); leave the rule in place as belt and braces.
- The bot/prefetch user agent list lives as a code constant, not an env var.

**Critical test scenarios** (each maps to an acceptance criterion):
- Happy path: publish a card, `GET /c/<slug>` returns the styled page and increments `view`; `GET /c/<slug>?src=qr` increments `scan`; `GET /c/<slug>.vcf` returns identical bytes and increments `download`. Verifies **AC-1, AC-2, AC-3**.
- Bot filtering: a request with an Apple/Slack/Googlebot user agent serves normally but increments nothing. Verifies **AC-4**.
- Fire and forget: with the counter write forced to throw, the page and the `.vcf` still return 200 with correct content. Verifies **AC-5**.
- Unpublished/unknown: an unpublished or bogus slug returns 404 from both routes and writes no row; a card unpublished after activity keeps its rows. Verifies **AC-6**.
- Concurrency: many simultaneous hits on one slug/day/metric produce a single row whose count equals the number of hits. Verifies **AC-3**.
- Authorization: a member requesting another member's card stats gets 403; a member's Dashboard shows only their own totals; owner/admin see org wide. Verifies **AC-7, AC-8**.
- Migration safety: the generated SQL is `CREATE TABLE`/`CREATE INDEX` only, no `DROP TABLE`. Verifies **AC-11**.

## Build plan

Ordered as a tracer bullet that stays end to end but keeps the one risky step (the domain rebind) last and isolated, honoring the hard "do not break the app" constraint (no recorded project build approach, so end to end slices assumed).

1. Additive migration: create `card_stat_daily` with its composite primary key and the two indexes; verify the generated SQL is create only, no table rebuild. Satisfies **AC-3, AC-11**.
2. Counting service `recordCardHit(env, { fileId, orgId, metric })`: UPSERT increment, bot/prefetch user agent filter, always wrapped so it cannot throw into the caller. Satisfies **AC-3, AC-4, AC-5**.
3. Slug resolver for the public path: map `<slug>` to the published file row (org, id, R2 key) or a not found result, reusing existing publish lookups. Satisfies **AC-6**.
4. Landing HTML builder: self contained inline styled page from `parseVcard` + brand config + `resolveSocials` (name, title, org, `tel:`/`mailto:`, address + map link, socials, "Add to contacts" download, optional QR), with OG/Twitter meta for chat unfurls and a `noindex` meta. Satisfies **AC-2, AC-10**.
5. Public routes under `/c/` on the app: `.vcf` streams the R2 object with identical bytes/type and records a download; the bare slug renders the landing and records a view, or a scan when `?src=qr`; both 404 cleanly, both emit `X-Robots-Tag`, both disable edge caching, both count via `waitUntil`. Verify on `www.awvcard.com/c/...` first, before any rebind. Satisfies **AC-1, AC-2, AC-3, AC-5, AC-6, AC-10**.
6. QR + signature repoint: new QR codes and the email signature encode the landing URL with `?src=qr`, keeping the `.vcf` as the download target behind "Add to contacts". Satisfies **AC-9**.
7. In app stats reads: aggregate `card_stat_daily` for the current Files page's rows (totals + last activity) and add the columns to the Files table; add `GET /api/cards/[id]/stats` + a per card trend view; extend the Dashboard loader with org level totals, a top cards list, and a trend, all role scoped. Satisfies **AC-7, AC-8**.
8. Cutover: in `wrangler.jsonc`, move `contacts.awvcard.com` from the R2 bucket to the app Worker as a custom domain; confirm a published `.vcf` is byte identical and the landing renders; rollback path is repointing the domain back to the R2 bucket. Satisfies **AC-1**.
9. Tests: counting UPSERT + concurrency, bot filter, fire and forget, 404 on unpublished, org scoped stats reads, and a Files page totals aggregation case. Satisfies **AC-3, AC-4, AC-5, AC-6, AC-7, AC-8**.

## Consequences

**Positive**:
- Every published card gets a proper, mobile friendly page with one tap "Add to contacts", instead of a raw file download.
- Staff get real per card view/scan/download numbers in the app, org wide for admins, with the three metrics cleanly separated for cards published from now on.
- All counting data lives in D1 beside the file rows, so it reads with ordinary org scoped queries and the existing role logic; no new infrastructure to run.
- Existing QR codes and signatures keep working untouched.

**Negative / tradeoffs**:
- The app Worker is now in the path for public card resolution; a bad app deploy can affect public cards, which R2 served independently before. Mitigated by a dependency light public path, fire and forget counting, and a one step rollback.
- The counted responses cannot be edge cached, so every public hit reaches the Worker (small payloads, but more origin requests than R2 direct).
- Scans and downloads can only be told apart for cards whose QR/signature was generated after this ships; legacy printed QRs that hit the `.vcf` count as downloads, not scans.
- Public counts are best effort and could be inflated by direct URL abuse; they are engagement signals, not audited figures.

**Neutral**:
- One new D1 table and an additive migration; no change to existing tables.
- The landing page is intentionally built as a standalone inline styled HTML string (like the signature), a slightly different rendering path from the app's Tailwind UI.
- The `?src=qr` convention becomes part of how QR/signature URLs are built.

## Follow-up

- [ ] Decide a retention/rollup policy if `card_stat_daily` ever grows large (unlikely at internal scale); daily granularity already bounds it.
- [ ] If per row aggregation on the Files page becomes slow at very large card counts, revisit adding denormalized total columns kept in sync on write (explicitly avoided now to prevent drift).
- [ ] Confirm whether the Dashboard engagement panel should offer a date range control or a fixed window (e.g. last 30 days) at build time.
- [ ] Consider a lightweight app level rate limit on the public routes if abuse of the counts is ever observed (Cloudflare handles volumetric abuse today).
- [ ] Real AW "Schedule a meeting" and social URLs still come from the engineer (shared with the signature work); the landing reuses the same brand/social config.
