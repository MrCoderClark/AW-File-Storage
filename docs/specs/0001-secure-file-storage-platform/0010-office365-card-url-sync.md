# 0010. Sync each published card's URL into Office 365 CustomAttribute1

**Date**: 2026-09-02

## Summary

Staff put a person's public card address into their Office 365 mailbox field `CustomAttribute1` today, by hand. This feature does it automatically: when a card is published or edited, the app writes that card's public `.vcf` URL into the matching person's `extensionAttribute1` (which is Exchange `CustomAttribute1`) through Microsoft Graph, and clears it again when the card is unpublished or deleted. A nightly job re-checks every published card and fixes any drift. The tenant is cloud-only, so this attribute is writable through Graph (it is read-only for on-premises synced users, which does not apply here). No person visits Graph; the app calls it server side with its own app credentials.

## Context

Each America Works person has a published contact card at a stable public address (spec 0008): the `.vcf` at `https://contacts.awvcard.com/c/<slug>.vcf`. The operator already stores that address in each mailbox's Exchange `CustomAttribute1` so Outlook and other tools can surface it, but does it manually, one person at a time, for 100+ people. It goes stale whenever a card is added, edited, unpublished, or its address changes.

The tenant is **cloud-only** (users are not synchronised from on-premises Active Directory, confirmed by the operator). That matters because the Graph property behind `CustomAttribute1`, `onPremisesExtensionAttributes.extensionAttribute1`, is writable through Graph **only** for cloud-only users; for directory-synced users it is mastered on-premises and read-only. Cloud-only removes that blocker, so the app can write it directly.

Forces at play: the write must be app-only (a background job, no signed-in person), so it uses Graph client credentials with an Entra app registration and admin consent. The project already runs a Cloudflare cron worker, a natural home for a nightly reconcile. Microsoft Graph throttles (HTTP 429) and the tenant has 100+ users, so writes must be idempotent and batched. And the whole thing must be inert until it is configured, so the existing publish flow keeps working with no Graph set up.

## Requirements

**User stories**:
- As the operator, I want each published card's URL written into the person's `CustomAttribute1` automatically, so that I stop doing it by hand and it never goes stale.
- As the operator, I want the attribute cleared when a card is unpublished or deleted, so that Outlook never shows a dead link.
- As the operator, I want to see which cards synced and which could not be matched to a mailbox, so that I can fix the exceptions.
- As the operator, I want publishing to keep working normally when the Graph integration is not configured or is temporarily failing.

**Acceptance criteria**:
- **AC-1**: When a card is published or edited, the app writes that card's public `.vcf` URL (`publicUrlFor`) into `extensionAttribute1` of the O365 user whose `mail` or `userPrincipalName` equals the card's contact email, using Graph app-only auth.
- **AC-2**: Writes are idempotent. The attribute is PATCHed only when the target value differs from the value already stored there; a re-run with no change makes no write.
- **AC-3**: On unpublish, delete, or a change in the matched user (the card's email now maps to a different or no mailbox), the previously written value is cleared (set to null), so it never points at a dead or wrong URL.
- **AC-4**: A nightly reconcile re-checks every published card across all orgs, corrects drift, batches its Graph calls, and backs off on HTTP 429 per the `Retry-After` header.
- **AC-5**: A card whose contact email matches zero or more than one O365 user is handled safely: no write happens, and the outcome (`no_match` or `ambiguous`) is recorded.
- **AC-6**: Every sync outcome (`synced`, `cleared`, `no_match`, `ambiguous`, `error`) is recorded as an audit row and as a per-card sync status + timestamp visible in the app.
- **AC-7**: When the integration is not configured (secrets absent or the feature flag off), the app, publishing, and editing work exactly as before, with no errors and no failed writes.
- **AC-8**: Graph credentials live only as Worker secrets, never in code, the client bundle, or the database; the sync runs server side only.

## Options considered

### Option 1: Event-driven write on publish/edit + nightly reconcile (chosen)

Write to Graph the moment a card changes (publish, edit, unpublish, delete), and run a nightly reconcile that re-asserts every published card. Store a small sync state per card for idempotency and visibility.

**Pros**:
- The attribute is correct within seconds of a change, and the nightly pass repairs any missed event or external drift.
- Idempotent and observable; the operator sees per-card status and exceptions.

**Cons**:
- Two write paths (immediate + nightly) to keep consistent.
- Adds sync-state columns and a new cron job.

### Option 2: Nightly reconcile only

Skip the immediate write; a single nightly job pushes every published card's URL.

**Pros**:
- One code path, simplest to reason about.

**Cons**:
- Up to a day of staleness after a card is published or changed, which is the exact manual pain we are removing. Rejected as the primary behaviour, but its reconcile loop is reused as the nightly pass in Option 1.

### Option 3: Store the URL as a Graph open extension or schema extension instead of `extensionAttribute1`

Use a custom Graph extension property rather than the Exchange custom attribute.

**Pros**:
- Cloud-writable with narrower permissions, no dependence on the Exchange attribute.

**Cons**:
- Not surfaced in Outlook / the address book the way `CustomAttribute1` is, so it does not serve the operator's actual use. Rejected: the requirement is specifically `CustomAttribute1`.

## Decision

**Chosen option**: Option 1: write `extensionAttribute1` on every card change and reconcile nightly, through Microsoft Graph app-only (client credentials), matching the card to a mailbox by email, with per-card sync state for idempotency and visibility.

**Implementation skills**: `msgraph` (`.agents/skills/msgraph/` or the project's skills dir) — the authoritative source for Graph endpoints, permissions, `$batch`, and throttling; consult it for the exact request shapes when building.

## Rationale

The manual pain is staleness right after a change, so the design writes on the change itself (Option 1) rather than waiting for a nightly pass (Option 2); the nightly reconcile is kept, but as a safety net for missed events and external edits, not the main path. Cloud-only tenancy is what makes writing `extensionAttribute1` viable at all, so the spec leans on it and records it as the load-bearing assumption. App-only client credentials are the only fit for a background job with no signed-in person, and the existing cron worker already proves the pattern for scheduled, bearer-authenticated calls into the app. `CustomAttribute1` is non-negotiable because it is where Outlook reads it, which rules out the cleaner extension-property route (Option 3). Idempotency and batching are not optional niceties here: with 100+ users and Graph throttling, a job that rewrites everything every night would burn quota and risk 429s, so the design compares before it writes and batches the nightly pass.

## Feature design

**Data model sketch**: additive columns on the existing `file` table (no table rebuild, per the project's D1 migration discipline), holding per-card sync state. All nullable; only meaningful for published vCards.

| Column | Type | Meaning |
|---|---|---|
| `o365_user_id` | text, null | the matched Graph user's object id, or null if unmatched |
| `o365_synced_url` | text, null | the value last written to `extensionAttribute1` (drives idempotent diffing) |
| `o365_synced_at` | integer (ms), null | when the last successful sync ran |
| `o365_sync_status` | text, null | `synced` \| `cleared` \| `no_match` \| `ambiguous` \| `error` |
| `o365_sync_error` | text, null | last error message, when status is `error` |

**State transitions** (per card's sync state): `(none)` → on publish/edit: `synced` (write ok) \| `no_match` \| `ambiguous` \| `error`; `synced` → on unpublish/delete or matched-user change: `cleared` (old attribute set null) then re-evaluated for the new state; any state → nightly reconcile re-computes it. A card only ever writes to the one currently matched mailbox; a change of match clears the old before setting the new.

**API surface** (mostly internal server functions + one cron endpoint; no browser-facing Graph):

| Surface | Method | Auth | Purpose |
|---|---|---|---|
| `syncCardToO365(env, fileId)` (service) | server | internal | match + write/clear one card, update its sync state, audit |
| `reconcileO365(env)` (service) | server | internal | iterate all published cards, batch-check current values, PATCH only diffs |
| `/api/cron/o365-sync` | POST | bearer `CRON_SECRET` + `Origin` (like the existing cleanup cron) | nightly trigger for `reconcileO365` |
| Graph: token | POST | client credentials | `login.microsoftonline.com/{tenant}/oauth2/v2.0/token`, scope `https://graph.microsoft.com/.default`; token cached for the run |
| Graph: match | GET | app-only | `/users?$filter=mail eq '<email>' or userPrincipalName eq '<email>'&$select=id,mail,userPrincipalName,onPremisesExtensionAttributes` |
| Graph: write | PATCH | app-only | `/users/{id}` body `{ "onPremisesExtensionAttributes": { "extensionAttribute1": "<url or null>" } }`; batched via `$batch` in the nightly run |

The publish (`finalize`), edit (`editVcard`), unpublish, and delete paths call `syncCardToO365` after their own work commits (best effort, never blocking or failing the user action).

**Key invariants**:
- A PATCH happens only when the intended value differs from the attribute's current value (idempotency, AC-2).
- The URL written is always the current `publicUrlFor(slug)`; the value is cleared to null when the card is not a live published vCard, or has no unique mailbox match.
- A card writes to at most one mailbox; changing the match clears the previous mailbox first.
- Graph credentials are read only from Worker secrets; the feature is a no-op when they are absent (AC-7, AC-8).
- Every state-changing sync writes one audit row before returning (project audit rule).

**Security model**:
- App-only Graph access with `User.ReadWrite.All` (application) and admin consent; runs server side only, never exposed to the browser. `User.ReadWrite.All` is broad; scoping the app to an Administrative Unit (or a custom directory role) so it can only write the intended users is a hardening follow-up.
- No new end-user authz surface; the cron endpoint is gated by `CRON_SECRET` + origin exactly like the existing cleanup cron.
- Sync state columns hold no secret data (a user id, a public URL, a status).

**Configuration required**:
- `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET` (or a certificate): Worker secrets for client-credentials auth.
- `O365_SYNC_ENABLED` (non-secret flag, default off): master switch so the app runs normally until the integration is set up and verified.
- The cron worker gains a nightly schedule + a call to `/api/cron/o365-sync` (mirrors the existing cleanup call).
- Prerequisite (operator, outside code): the Entra app registration with the permission + admin consent, and confirmation that no Conditional Access policy blocks this app's app-only token.

**Critical test scenarios** (each maps to an acceptance criterion):
- Happy path: publish a card whose email matches one mailbox → `extensionAttribute1` is set to the `.vcf` URL, status `synced`, audit row written. Verifies **AC-1, AC-6**.
- Idempotent: run the sync again with no change → no PATCH is issued. Verifies **AC-2**.
- Clear: unpublish the card → the attribute is set null, status `cleared`. Verifies **AC-3**.
- No/again match: email matches zero, then two, mailboxes → no write, status `no_match` then `ambiguous`, recorded. Verifies **AC-5**.
- Reconcile + throttle: nightly run over many cards batches its calls and, on a simulated 429, waits `Retry-After` and retries. Verifies **AC-4**.
- Not configured: with secrets absent / flag off, publish and edit succeed and write nothing to Graph. Verifies **AC-7**.

## Build plan

Tracer-bullet order: stand up one card syncing end to end (migration → auth → match/write for one card wired into publish), then thicken with clear-on-unpublish, the nightly reconcile, the UI status, and tests (no build approach recorded for this feature; end-to-end slice assumed).

1. Additive migration: the five `o365_*` columns on `file` (create/alter only, no table rebuild). Satisfies **AC-6**.
2. Graph client (`src/server/graph.ts`): client-credentials token acquisition + caching, a typed `patchUserExtensionAttribute` and a `findUserByEmail`, 429/`Retry-After` handling, all reading secrets from env and a `graphConfigured(env)` guard. Satisfies **AC-1, AC-2, AC-7, AC-8**.
3. `syncCardToO365(env, fileId)`: resolve the card, match by email (0/1/many), compare to `o365_synced_url`, PATCH or clear only on a diff, update the sync-state columns, write the audit row. Satisfies **AC-1, AC-2, AC-3, AC-5, AC-6**.
4. Wire triggers: call `syncCardToO365` (best effort, non-blocking) from `finalize`/`editVcard` (set) and `unpublishVcard`/`deleteFile` (clear). Satisfies **AC-1, AC-3**.
5. `reconcileO365(env)` + `POST /api/cron/o365-sync` (bearer + origin) + the cron worker schedule; batch current-value reads via `$batch`, PATCH only diffs, back off on 429. Satisfies **AC-4**.
6. Files UI: a small per-card sync indicator (synced / no match / ambiguous / error + last-synced), reusing the engagement-cell pattern, so exceptions are visible. Satisfies **AC-6**.
7. Tests: idempotent diff, clear-on-unpublish, no-match/ambiguous, not-configured no-op, and the reconcile diff/backoff path (Graph mocked). Satisfies **AC-2..AC-7**.

## Consequences

**Positive**:
- The manual per-mailbox update disappears; card URLs in Outlook stay correct automatically, within seconds of a change and re-checked nightly.
- Idempotent, batched, and observable: the operator sees which cards synced and which need attention, and re-runs are cheap.
- Inert until configured, so it ships without risk to the existing publish flow.

**Negative / tradeoffs**:
- New external dependency (Microsoft Graph) with its own auth, throttling, and failure modes to operate; a client secret that expires and must be rotated (the operator already hit an expired-secret app).
- `User.ReadWrite.All` is a broad permission until the Administrative Unit scoping follow-up is done.
- Two write paths (event + nightly) to keep consistent.
- Relies on cloud-only tenancy; if the tenant ever becomes hybrid (on-prem synced), `extensionAttribute1` turns read-only in Graph and the write path must move to on-prem AD.

**Neutral**:
- Adds five columns to `file` and one cron job; no change to the public card serving path (spec 0008/0009).
- Matching is by email; a card with no mailbox (e.g. a shared or non-staff card) simply stays `no_match`, which is expected, not an error.

## Follow-up

- [ ] Scope the Entra app to an Administrative Unit (or a custom role) so `User.ReadWrite.All` cannot touch users outside the intended set.
- [ ] Prefer a certificate over a client secret for the daemon credential, to avoid the secret-expiry outage the operator has already seen.
- [ ] Optional: an admin "sync now" button (per card and org-wide) that calls `syncCardToO365` / `reconcileO365` on demand, for immediate repair without waiting for the nightly pass.
- [ ] Confirm whether a card's contact email is guaranteed to equal the person's O365 `mail`/`userPrincipalName`; if some cards use a non-mailbox email, decide a secondary match (e.g. an explicit user-id field on the card).
- [ ] Decide a retention/alerting approach for persistent `error`/`no_match` cards (e.g. surface a count on the dashboard).
