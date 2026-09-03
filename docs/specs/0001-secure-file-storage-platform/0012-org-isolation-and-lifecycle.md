# 0012. Organization isolation hardening + lifecycle/management UI

**Date**: 2026-09-03

## Summary

The app has been multi-tenant since spec 0002: every tenant table carries `org_id`, a wrapped Drizzle client (`org-db.ts`) makes an un-scoped query impossible to write, a cross-org read returns 404 (never revealing existence), storage keys are org-namespaced, and the acting organization always comes from `session.activeOrganizationId` — never the browser. That foundation is sound. But features added since 0002 (regional social links, card analytics, app settings, the Office 365 sync) grew **outside** that guarded surface, and there is no owner-facing organization management. This spec does two things. First, it **hardens and proves** isolation across the whole surface: the site-wide `app_settings` row becomes **per-organization**, the two hand-scoped tables (`org_social_link`, `card_stat_daily`) are folded into the guarded `orgDb()` surface, the "no module bypasses the wrapper" test that 0002 promised is finally written, and cross-org 404 behaviour is tested route by route. Second, it adds the **lifecycle/management UI**: an organization switcher, a Settings → Organization section, rename, delete, and — restricted to the platform ("app") owner — create-organization. Onboarding stays invitation-based; there is no public signup and no billing in this spec.

## Context

Spec 0002 built isolation as "a property of the system, not of someone remembering to check." The load-bearing mechanism is `orgDb(orgId)`: it injects `org_id` on every read and insert for the four original tenant tables (`file`, `file_version`, `upload_session`, `audit_event`) and throws `OrgScopeError` when the organization is missing, so the unsafe query cannot be written through it. That still holds. Two gaps have opened since:

- **New state landed outside the wrapper.** `org_social_link` (spec 0009 follow-up) and `card_stat_daily` (spec 0008) carry `org_id` but are queried directly in `social-links.ts` / `card-stats.ts` with hand-written `eq(table.orgId, …)` filters. They are correct today, but only by discipline — exactly the failure mode 0002's wrapper exists to remove.
- **`app_settings` is a single global row** (`id = "app"`) holding `o365SyncEnabled` and `requireAppHostCardLogin`. It was deliberately kept off the `organization` table (a rebuild of that parent cascade-wipes children on D1 — see gotcha #9), but the consequence is that these toggles are **shared across every organization**, and any org owner/admin can change them for everyone from their own Settings. In a multi-tenant product that is a cross-tenant control, not an org setting.

And 0002's build plan #3 promised "a test asserts that no other file imports `db.ts`" — that test was never written, and the `repos/` directory it assumed never materialised (the scoping modules live in `src/server/*.ts`).

On the product side, the identity plumbing for multiple organizations already exists (Better Auth's `organization` plugin, `session.activeOrganizationId`, and `shell.ts` already lists every organization the user belongs to), but nothing surfaces it: there is no switcher, no organization settings page, and no rename/delete/create.

## Requirements

**User stories**:
- As an owner, I want my organization's *settings* (card-login gate, Office 365 opt-in) to be mine alone, so another organization's owner cannot change how my organization behaves.
- As a maintainer, I want every tenant table reached only through the guarded wrapper, and a test that fails if any module bypasses it, so isolation cannot silently regress.
- As a user in more than one organization, I want to switch between them from the header, and to see and rename the one I am in.
- As an owner, I want to delete an organization I own, with its data and stored files removed.
- As the platform (app) owner, I want to be the only one who can create a new organization, so tenant creation stays controlled.

**Acceptance criteria**:
- **AC-1**: `o365SyncEnabled` and `requireAppHostCardLogin` are stored **per organization**. Changing organization A's value never affects organization B. Reads resolve to the relevant organization: the card-login gate uses the *served card's* organization; the Office 365 reconcile uses *each card's* organization.
- **AC-2**: `org_social_link`, `card_stat_daily`, and the new per-org settings are reached only through `orgDb()` helpers; a call with no organization in scope throws `OrgScopeError`, exactly like the existing `files` helper.
- **AC-3**: A test scans `src/**` and fails if any module outside a small allowlist imports the raw D1 client (`./db`). The allowlist is `org-db.ts`, `auth.ts` (the Better Auth adapter), and the identity-only readers `session.ts` / `shell.ts`.
- **AC-4**: For representative routes (`files/[id]`, `cards/[id]/stats`, `social-links/[state]`, `members/[id]`), a request carrying another organization's id returns **404** — never 403, never the row.
- **AC-5**: A user who belongs to more than one organization can switch the active one from the header; the role is re-read from `member` on switch (never trusted from the client), and every scoped view then shows only the newly-active organization's data.
- **AC-6**: An owner can rename their organization and delete it. Delete removes the organization's rows (files, versions, uploads, audit, social links, card stats, settings) **and** its stored R2 objects, and is audited.
- **AC-7**: Creating an organization is allowed **only** for the platform owner. A non-platform-owner has no path (UI or API) to create one, and an attempt is refused server-side.
- **AC-8**: The migration is additive — it creates `org_settings` and never rebuilds `organization` (gotcha #9). Existing organizations are backfilled from the current global `app_settings` values, so behaviour is unchanged at cutover.

## Decision

**Chosen approach**:
1. **Per-org settings** in a new additive `org_settings` table (not columns on `organization`), read/written through new `orgDb().settings` helpers, with the O365 reconcile and the card-login gate rewired to resolve the setting per organization.
2. **Fold the hand-scoped tables** (`org_social_link`, `card_stat_daily`) into `orgDb()` as `socialLinks` / `cardStats` helpers, and migrate their modules onto them.
3. **Write the import-guard test** (AC-3) and **route-level cross-org tests** (AC-4).
4. **Lifecycle UI**: header switcher (`organization.setActive`), Settings → Organization (rename via `organization.update`, storage/identity display, the per-org toggles), delete (`organization.delete` + R2 sweep + audit), and platform-owner-gated create (`organization.create`).

**Platform owner** is identified by a `PLATFORM_OWNER_EMAILS` Worker var (comma-separated, matched case-insensitively against the session user's verified email) via an `isPlatformOwner(session)` helper. Chosen over a DB flag or "owner of the first org" because it needs no schema change, is trivial to audit, and mirrors the existing `TRUSTED_ORIGINS` env-list pattern.

**Rejected**: putting the toggles on the `organization` row via Better Auth `additionalFields` — it triggers a D1 table-rebuild of a parent table, which cascade-wipes children (gotcha #9); this is exactly why `app_settings` was a separate table in the first place.

## Feature design

**Data model** — new additive table (`src/server/db/schema.ts`):

| Table | Fields | Notes |
|---|---|---|
| `org_settings` | `org_id` PK/FK → `organization` (`onDelete: cascade`), `require_app_host_card_login` bool default true, `o365_sync_enabled` bool default false, `updated_at` | One row per org. Additive create-only migration; `organization` is never rebuilt (gotcha #9). Missing row → treated as defaults. |

`app_settings` is left in place but unused after cutover; a later migration drops it once the per-org path is proven.

**Scoping surface** (`src/server/org-db.ts`) — add three helpers alongside `files`/`versions`/`uploads`/`audit`, each constrained to `orgId` the same way:
- `settings`: `get()` (returns the org's row or defaults), `set(patch)` (upsert).
- `socialLinks`: `list()`, `get(state)`, `upsert(state, patch)`, `remove(state)`.
- `cardStats`: the reads/increments `card-stats.ts` needs today, moved verbatim behind the wrapper.

**Rewired readers** (per-org, AC-1):
- `o365-sync.ts` `o365Active()` — takes the org (or resolves the card's org) and reads `orgDb(org).settings`. `reconcileO365` groups published vcards by org and skips an org whose toggle is off. GRAPH_* creds stay platform-level and still gate the feature globally (`graphConfigured`).
- Host-based card gate (spec 0009 reader) — resolve the served card's `orgId`, read that org's `require_app_host_card_login`.
- `settings/site` + `settings/o365` routes — write the acting org's row (`session.activeOrganizationId`).

**Lifecycle UI**:
- **Switcher** — `shell.ts` already returns `orgs` + `activeOrgId`; add a header dropdown (shown only when `orgs.length > 1`) calling `organization.setActive({ organizationId })` then reloading (AC-5).
- **Settings → Organization** — new `settings/organization/page.tsx` + nav entry: org name/id/slug, storage used/quota, public domain; rename (owner) via `organization.update`; the per-org toggles live here (or stay on Site/O365 pages, now writing the org row).
- **Delete** — typed-confirmation owner action: `organization.delete` (DB cascades) **plus** an R2 sweep of `files/${orgId}/…` (the cascade does not touch blobs), audited (AC-6). Loud irreversible warning; the org's public cards go offline.
- **Create** — `isPlatformOwner`-gated action calling `organization.create` (creator → owner); the creator can then switch in (AC-7).

**Key invariants**:
- A tenant table — now including social links, card stats, and org settings — is never read or written without an organization in scope.
- Per-org settings resolve to the *data's* organization (the served card, the synced card), not merely the acting session, so a background job honours each org's choice.
- Organization create is gated by the platform owner; org rename/delete stay owner-gated per the spec 0002 role matrix.

**Security model**: unchanged in shape (application-layer isolation, checked twice: the scoped client cannot see another org's rows, and role gates the capability). This spec widens the guarded surface to the tables that had slipped outside it, makes a cross-tenant control (`app_settings`) per-tenant, and adds a platform-owner tier for the one genuinely platform-level action (creating tenants). A foreign id still returns 404 everywhere (AC-4).

**Configuration required**:
- `PLATFORM_OWNER_EMAILS` — Worker var, comma-separated verified emails allowed to create organizations.

**Critical test scenarios** (each maps to an AC):
- Per-org settings: org A toggles O365 on, org B off; the reconcile syncs only A's cards. Verifies **AC-1**.
- Wrapper coverage: `orgDb("", db).settings.get()` / `.socialLinks.list()` / `.cardStats…` throw `OrgScopeError`; scoped reads see only the org's rows. Verifies **AC-2**.
- Import guard: a module added that imports `./db` outside the allowlist fails the test. Verifies **AC-3**.
- Cross-org 404: org A requesting org B's file / card stats / social-link state / member id gets 404. Verifies **AC-4**.
- Switch: a two-org user switches and sees only the newly-active org; role re-read from `member`. Verifies **AC-5**.
- Delete: a throwaway org's rows and `files/${orgId}/…` objects are gone, and an audit row records it. Verifies **AC-6**.
- Create gate: the platform owner creates an org; a normal owner is refused server-side. Verifies **AC-7**.
- Migration: applying it backfills one `org_settings` row per org from the old global values and never rebuilds `organization`. Verifies **AC-8**.

## Migration plan

**Strategy**: additive, strangler-style for the settings move (per-org table live and read alongside, then the global row retired).

**Phases**:
1. Create `org_settings` (additive). Backfill one row per existing org from the current global `app_settings` values (O365 currently ON), so nothing changes at cutover.
2. Ship `orgDb()` helpers (`settings`, `socialLinks`, `cardStats`) and migrate the modules onto them; rewire the O365 reconcile and the card-login gate to per-org reads.
3. Ship the lifecycle UI (switcher, Organization settings, rename, delete, create).
4. Once per-org settings are verified in prod, a follow-up migration drops `app_settings`.

**Rollback**: the settings readers can fall back to `app_settings` until phase 4; the UI is additive. Do not drop `app_settings` (phase 4) until per-org reads are proven.

**Risks**: a reader still pointing at the global row after cutover (caught by the per-org tests); the O365 reconcile iterating orgs incorrectly (tested with a two-org fixture); an org delete leaving orphaned R2 objects (the sweep covers `files/${orgId}/…`; anything missed is reclaimed by the existing cleanup job).

## Build plan

Spec order (schema → guarded surface → tests → UI):
1. `org_settings` table + additive migration + backfill. Satisfies **AC-8**.
2. `orgDb()` `settings` / `socialLinks` / `cardStats` helpers; migrate `social-links.ts`, `card-stats.ts`, `app-settings.ts` (→ per-org) onto them; rewire `o365-sync.ts` + the card-login gate per-org. Satisfies **AC-1, AC-2**.
3. `test/no-db-bypass.test.ts` (import guard) + cross-org 404 route tests + extend `test/isolation.test.ts`. Satisfies **AC-3, AC-4**.
4. `isPlatformOwner()` + `PLATFORM_OWNER_EMAILS`. Satisfies **AC-7** (server gate).
5. UI: header switcher, Settings → Organization (rename + toggles + storage), delete (+ R2 sweep + audit), create (platform-owner-gated). Satisfies **AC-5, AC-6, AC-7**.

## Consequences

**Positive**:
- Every tenant table is behind the guarded surface, and a test fails if that regresses.
- A per-tenant setting is genuinely per-tenant; one org can no longer change another's behaviour.
- Owners get real organization management; tenant creation is controlled by the platform owner.

**Negative / tradeoffs**:
- The O365 reconcile is slightly more work (group/resolve by org) than reading one global flag.
- A per-org toggle for O365 is still bounded by a single shared Entra app/tenant — an org opts *its* cards in/out, but true per-tenant Microsoft isolation is a later phase.
- A platform-owner tier is a new concept to keep correct (the env list).

**Neutral**:
- `public_slug` stays globally unique on one shared public domain — a deliberate shared-namespace choice, not a leak (cards are public); per-org domains are out of scope.
- `app_settings` lingers (unused) until the phase-4 drop.

## Follow-up

- [ ] Drop `app_settings` once per-org settings are proven in prod (migration phase 4).
- [ ] Consider per-org public domains (retire the vestigial `organization.publicDomain` or make it real).
- [ ] Revisit whether org **delete** should also be platform-owner-gated (currently org-owner per the 0002 role matrix).
