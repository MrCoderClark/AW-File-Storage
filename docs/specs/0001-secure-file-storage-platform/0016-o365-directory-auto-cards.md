# 0016. Auto-provision contact cards from the Office 365 directory

**Date**: 2026-09-04

## Summary

Today a contact card is created by a person — the Create-Card wizard or a `.vcf`
upload — and the Office 365 integration (specs 0010/0013) only writes the card's
public URL into the staff member's Exchange **CustomAttribute1** *after* someone
made the card. This spec closes the last manual step: when a **new Office 365 user**
appears in an org's tenant, the app **builds a contact vCard from that user's
directory details, publishes it, and writes the public URL into their
CustomAttribute1 — automatically**, with no card authoring and, deliberately, **no
web-app login/account** created for them (this is not SCIM; a card is a file, not a
user). It is **forward-only**: only users **created after the feature is enabled** get
a card — enabling it **never backfills** the org's existing staff. It is a **per-org,
opt-in** extension of the O365 sync each org already configures with its own Entra app.
A new user's card appears **within minutes** of their account existing, via a frequent
directory poll that waits for the mailbox to be ready; a nightly reconcile and the
existing "Sync all now" button are the safety nets. When a user is disabled or unlicensed, their auto-created card is unpublished
and the attribute cleared.

## Context

The pieces already exist; this spec composes them:
- **Per-org Graph credentials** (spec 0013, `org_o365` + `loadGraphCreds`) — each org
  authenticates to **its own** Microsoft tenant, app-only. No global creds.
- **The O365 sync** (spec 0010, `src/server/o365-sync.ts`) — `syncCardToO365` writes
  or clears one card's URL in CustomAttribute1; `reconcileO365` re-asserts every live
  card nightly across all orgs; gated per-org by the credentials + the
  `o365SyncEnabled` toggle (spec 0012 `org_settings`).
- **The org → domain map** (spec 0014, `org_domains` + `resolveOrgForEmail`) — a
  verified Microsoft domain maps an email to exactly one org.
- **The vCard builder + publish pipeline** (`src/lib/vcard-builder.ts` `buildVcard`,
  `finalizeUpload` in `src/server/uploads.ts`) — turns typed fields into a `.vcf` and
  publishes it (private + public R2 objects, a stable slug, denormalised `contact_*`
  search columns, landing page + analytics).
- **The Graph client** (`src/server/graph.ts`) — token/cert auth, `findUsersByEmail`,
  `patchUserExtensionAttribute1`, `getVerifiedDomains`, 429 backoff.

What is missing: (a) **enumerating** an org's directory users with the fields a vCard
needs, (b) **building + publishing** a card server-side (no browser upload), (c) a
**per-org toggle** to opt in, and (d) a **frequent trigger** so it happens close to
account creation. Runtime is Cloudflare Workers; the companion cron worker
(`cron/`) already drives scheduled work.

**Prior approach, rejected:** an earlier iteration (spec 0015, SCIM) had the
customer's Entra *push* users and created **app members**. That was the wrong model —
the goal is contact cards from the directory, not app logins — and it was removed
entirely. This spec is the correct realization of the same intent, built on the
Graph integration instead of SCIM.

## Requirements

**User stories**:
- As an org admin, I want a contact card to be created and published automatically for
  each of my Office 365 staff, so nobody has to author cards by hand.
- As an org admin, I want each new hire's card to appear on its own within minutes of
  their account being created, and their CustomAttribute1 filled in, so their card URL
  is ready in Exchange without me touching it.
- As an org admin, I want this to use **my** organization's own Microsoft tenant and be
  **off until I turn it on**, because it publishes staff contact details publicly.
- As an org admin, when a staff member leaves (account disabled or unlicensed), I want
  their auto-created card unpublished and the attribute cleared automatically.
- As a security- and privacy-conscious operator, I do NOT want these people to get app
  logins — only a published contact card — and I do not want one org's directory to
  ever be visible to another.

**Acceptance criteria**:
- **AC-1 (per-org opt-in)**: A new per-org toggle **"Auto-create contact cards from
  Office 365 users"** (`org_settings.o365AutoCardEnabled`, default **false**), in
  Settings → Office 365, owner/admin only. It is only effective when that org has
  **connected credentials** (spec 0013) **and** `o365SyncEnabled` is on. Off by default;
  turning it on shows a clear warning that it will **publish a public contact card for
  every licensed user** in the tenant.
- **AC-2 (scope + mailbox readiness)**: Cards are auto-created only for users who are
  **enabled**, **licensed**, and have a **mailbox** — detected by a non-empty `mail`
  attribute. A brand-new user whose mailbox has not provisioned yet (`mail` empty) is
  **skipped and retried** on a later run; this *is* the "wait ~5 minutes for the
  mailbox" behavior, detected rather than timed.
- **AC-2b (forward-only — no backfill)**: Enabling the toggle records a **cutoff**
  (`org_settings.o365AutoCardSince`, set to "now" on each enable). Only users whose
  Graph `createdDateTime` is **at/after the cutoff** are provisioned; **existing users
  created before the cutoff are never given a card**. "Sync all now" and the nightly
  sweep obey the same cutoff (they catch missed *new* users, not old ones). Absent a
  cutoff, nothing is created (fail-safe toward not backfilling).
- **AC-3 (org resolution)**: Each user's card belongs to the org resolved from the
  user's email **domain** via `org_domains` (spec 0014). A user whose domain does not
  map to the org being swept is skipped and logged (never cross-filed).
- **AC-4 (build + publish + attribute)**: The card is built from Graph directory fields
  — display/given/surname, `jobTitle`, `mobilePhone`/`businessPhones`, `mail`,
  `streetAddress`/`city`/`state`/`postalCode`/`country`, `companyName` — via
  `buildVcard`, then **published through the existing pipeline** (private + public
  objects, slug, `contact_*` columns, landing page), and its public URL written into
  the user's CustomAttribute1 by the existing `syncCardToO365`.
- **AC-5 (idempotent, non-clobbering)**: Auto-creation happens **only when no live
  published vCard already exists for that email** in the org. A person who already has
  a card (manual or previously auto-created) is never duplicated, and a **human-edited
  card is never overwritten**. A second run over the same directory is a no-op.
- **AC-6 (cadence)**: The per-org sweep runs on a **once-a-day, weekday schedule**
  (`0 13 * * 1-5`, ~9am ET) as a catch-up safety net, plus the on-demand **"Check for
  new users now"** action for same-day hires (the poll interval is a deployment
  choice, tuned down from every-minute for cost). Both only act on orgs with the toggle
  on + credentials. The on-demand action is **separate** from "Sync existing cards"
  (the spec-0010 reconcile of already-published cards): two buttons, each next to its
  own toggle — one re-asserts existing cards' attributes, the other provisions new
  users.
- **AC-7 (offboarding)**: When an auto-provisioned user becomes **disabled**
  (`accountEnabled: false`), **unlicensed**, or loses their mailbox, their
  **auto-created** card is **unpublished** and CustomAttribute1 **cleared**.
  Human-created cards are never auto-unpublished by this feature.
- **AC-8 (provenance)**: Auto-created cards carry a **source marker**
  (`file.source = 'o365_auto'`) so offboarding and the non-clobber rule can tell them
  from human-authored cards. Public pages keep their existing `noindex`.
- **AC-9 (isolation + safety)**: The sweep uses **each org's own** credentials and
  tenant; no cross-org read or write. Every auto-create / auto-unpublish is **audited**
  (system actor, `null` user). Migrations are **additive** (`ADD COLUMN` only; no
  rebuild of `org_settings`/`file`/`organization`, gotcha #9).

## Decision

**Chosen approach**: extend the O365 Graph sync with a **directory-provisioning
sweep**, gated by a per-org opt-in toggle, that creates + publishes cards from
directory users and reconciles offboarding — reusing the vCard builder, the publish
pipeline, and the existing CustomAttribute1 write. Near-real-time is achieved by
**polling** the directory frequently and gating on mailbox readiness (not by webhooks
or a fixed timer).

**Rejected**:
- **SCIM / Entra provisioning push** (spec 0015) — creates app logins the customer does
  not want; removed.
- **Graph change-notification subscriptions** for v1 — true event-driven creation, but
  adds a renewable (~3-day) subscription + a validated webhook endpoint. Polling
  delivers "within minutes" and gives mailbox-settling for free, at a fraction of the
  operational complexity. Recorded as a **future upgrade** for sub-minute latency.
- **A fixed 5-minute delay timer** — brittle; detecting the `mail` attribute waits
  exactly as long as the mailbox actually takes.
- **Creating cards for every user object** — would publish service accounts, rooms, and
  shared mailboxes; scope is enabled + licensed + mailboxed users only.

## Feature design

**Data model** — additive columns only (no table rebuild, gotcha #9):

| Table | Change | Notes |
|---|---|---|
| `org_settings` | `+ o365_auto_card_enabled` boolean, default `false`; `+ o365_auto_card_since` timestamp (nullable) | The per-org opt-in (AC-1) and the forward-only cutoff (AC-2b), stamped "now" on each enable. Read via `orgDb(orgId).settings.get()`. |
| `file` | `+ source` text, default `'manual'` | `'o365_auto'` marks an auto-provisioned card (AC-8); everything existing is `'manual'`. Used by the non-clobber rule and offboarding. The Graph user id is stored in the existing `o365UserId` column at creation. |

**Graph additions** (`src/server/graph.ts`): `listDirectoryUsers(creds)` — page through
`GET /users` (`@odata.nextLink`) selecting `id, accountEnabled, mail,
userPrincipalName, displayName, givenName, surname, jobTitle, mobilePhone,
businessPhones, streetAddress, city, state, postalCode, country, companyName,
department, assignedLicenses, createdDateTime, onPremisesExtensionAttributes`. Returns a typed
`GraphDirectoryUser[]`. Reuses `graphFetch` (auth + 429 backoff). Enumerating the
directory uses `User.Read.All`, already covered by the app's `User.ReadWrite.All`.

**Provisioning core** (new `src/server/o365-provision.ts`, on the `no-db-bypass`
allowlist — a cross-org system job like `o365-sync.ts`):
- `provisionCardsForOrg(env, orgId)` — no-op unless the org has creds
  (`loadGraphCreds`) **and** both toggles on. Then:
  1. `listDirectoryUsers(creds)`.
  2. **Create pass** — for each user that is enabled + licensed + has `mail`, **whose
     `createdDateTime` is at/after the org's cutoff** (AC-2b), whose domain resolves
     (via `org_domains`) to `orgId`, and who has **no live published vCard for that
     email**: map Graph fields → `CardFields`, `buildVcard`,
     `publishVcardServerSide(...)` with `source: 'o365_auto'`, `o365UserId: user.id`,
     then `syncCardToO365` to write CustomAttribute1. Audited `card.auto_created`.
  3. **Offboard pass** — for each live card in the org with `source = 'o365_auto'`
     whose user is now missing / `accountEnabled: false` / unlicensed / `mail` gone:
     unpublish + `syncCardToO365` clears the attribute. Audited `card.auto_unpublished`.
  - Best effort per user (one failure never stops the run); a small summary returned.
- `publishVcardServerSide(env, orgId, vcf, fields, {source, o365UserId})` — the
  server-side twin of `finalizeUpload`: write the private + public R2 objects at a
  derived slug, insert the `file` row with `contact_*` search fields, `kind: 'vcard'`,
  `visibility: 'public'`, `source`, `o365UserId`. Factored so both the browser finalize
  path and this path share the promotion logic (no browser staging upload in this path
  — the bytes are built in the Worker).

**Triggers / cadence** (`cron/` + a new route):
- **Scheduled poll**: a `0 13 * * 1-5` (weekdays ~9am ET) trigger on the companion cron
  worker; it branches on `event.cron` and calls a bearer-authed
  `POST /api/cron/o365-provision` → loops orgs with `o365AutoCardEnabled` on →
  `provisionCardsForOrg`. Once a day is enough because account creation is rare and the
  in-app button covers same-day hires; a full directory enumeration per run is cheap at
  this cadence (a `createdDateTime`-filtered delta query would let it run more often if
  ever wanted). The nightly `0 3 * * *` trigger keeps doing cleanup + the spec-0010
  reconcile (it does **not** provision).
- **On demand**: **two separate buttons** in Settings → Office 365 — **"Sync existing
  cards"** (`.../o365/sync` → `reconcileO365`, next to the sync toggle) and **"Check for
  new users now"** (`.../o365/provision` → `provisionCardsForOrg` for the acting org,
  next to the auto-card toggle).

**UI** (`src/components/o365-settings-section.tsx`): a second toggle under the existing
sync toggle — **"Auto-create contact cards from Office 365 users"** — owner/admin,
disabled until credentials are connected, **off by default**, with an inline warning:
*"This publishes a public contact card (name, title, phone, email, address) for every
licensed user in your Microsoft tenant, and keeps them in sync. Cards are unpublished
automatically when a user is disabled or unlicensed."* A small status line shows the
count of auto-created cards. Backed by the existing `PUT /api/settings/o365` (extended
with the new flag).

**Key invariants**:
- **Never creates an app login/account** — no `user`/`member` rows; a card is a `file`.
- **Per-org, opt-in, off by default**; uses only that org's own credentials + tenant.
- **One card per email**; auto-creation never duplicates or overwrites a human card.
- **Only `source = 'o365_auto'` cards** are auto-unpublished on offboarding.
- **Mailbox readiness is detected** (`mail` present), not timed.
- **Additive migrations**; every action **audited** (system actor).

**Security & privacy model**: This feature **publishes personal data** (name, title,
phone, email, address) to a public URL by design, so it is **opt-in, off by default,
warned at the toggle**, and public pages remain `noindex` (spec 0008/0009).
Cross-tenant isolation is preserved: the sweep authenticates with the org's own Entra
app and only files cards into the org its verified domain resolves to (spec 0014).
Graph access is app-only and least-privilege — directory read (`User.Read.All`) to
enumerate and the existing `User.ReadWrite.All` to write the attribute; the AU-scoped
role guidance from spec 0011/0013 still applies. Offboarding is part of the same
switch, so leaving the company removes the public card.

## Out of scope (future specs / follow-ups)

- **Real-time via Graph change-notification subscriptions** (sub-minute; renewable
  subscription + validated webhook) — the polling upgrade path.
- **Scoping filters** — restrict to a security group, department, or an
  `extensionAttribute` rule, and a **per-user suppression list** ("never publish this
  person").
- **Field/format customization** per org (which directory fields map to the card, phone
  formatting, which address).
- **Two-way** (editing a card writing back into the directory) — not planned.

## Verification

See [0016-verify.md](0016-verify.md). In brief: unit tests for field mapping, the
create pass (in-scope user with no card → card built + published + attribute set), the
mailbox-readiness skip (no `mail` → skipped, retried), the non-clobber rule (existing
card → no-op), and the offboard pass (disabled/unlicensed → unpublished + cleared);
plus per-org isolation and additive-migration checks. Manual: connect an org, enable
the toggle, create a licensed test user, confirm the card appears within ~10 min with
CustomAttribute1 set, then disable the user and confirm the card is unpublished.
