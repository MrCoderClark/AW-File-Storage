# 0014. Org membership & domain-based provisioning

**Date**: 2026-09-04

## Summary

The app is a controlled multi-tenant SaaS: the platform owner creates organizations (no self-signup, spec 0012), and every account is created through a secure **invite → accept** flow (spec 0005). What is missing is a **provisioning layer** — a fast, correct way to put people into organizations, both new and existing accounts, without hand-inviting one org at a time. This spec adds it. When the platform owner provisions a user, the app **suggests the organization from the user's email domain**, derived from that org's **verified Microsoft 365 domains** (so Microsoft's own domain proof is reused — no separate DNS step). The owner **confirms or overrides** — add more orgs, set a role per org, or clear — and the account is created through the same invite → accept flow (the person sets their own password). It also adds two adjacent needs: **assigning an existing account** to more orgs directly (no email round-trip), and **bulk CSV invites** with the same domain auto-match. Enterprise patterns beyond this (SCIM, SSO/JIT, groups, guests, seat limits) are recorded as a roadmap.

## Context

Today `createInvite` (`src/server/invitations.ts`) reserves one **org + email + role**, emails a link, and `acceptInvite` turns it into an account plus **one** membership. It is per-org and initiated by an org admin from Settings → Invitations. That stays. But there is no way to (a) know which org an email belongs to, (b) assign one person to several orgs in one action, or (c) onboard a list of people at once. Per-org O365 (spec 0013) gives us the missing signal: each configured org's Microsoft tenant has **verified domains** (`GET /domains`, `isVerified: true`), which map an email domain to an org with no extra verification. The runtime is Cloudflare Workers; `isPlatformOwner` (`src/server/platform.ts`) already gates the platform-owner tier.

## Requirements

**User stories**:
- As the platform owner, when I provision a user I want the app to pre-select their organization from the email domain, so I do not have to remember who belongs where.
- As the platform owner, I want to confirm or override that suggestion — add more orgs, set each role, or clear it — before anything is sent.
- As the platform owner, I want to add an **existing** account to another organization without making them re-accept an email.
- As the platform owner, I want to onboard a whole company from a **CSV** in one pass.
- As a security-conscious operator, I want accounts to still be created only through invite → accept (the person sets their own password), and cross-org assignment restricted to me.

**Acceptance criteria**:
- **AC-1**: Each org has a set of **verified domains**. For a configured O365 org they are fetched from Microsoft Graph (`GET /domains`, verified only) on save and on demand; the platform owner can also add/remove a domain manually. A domain maps to **at most one** org (unique), and **consumer domains** (gmail.com, outlook.com, …) are never matched or claimable.
- **AC-2**: In the provisioning console, entering an email **pre-selects** the org whose verified domain matches; the platform owner can change it, add more orgs (each with a role), or clear it. Nothing is created until they confirm.
- **AC-3**: Provisioning a new email creates **one** invitation email; on accept, the account is created (person sets their password) and **all** chosen memberships are added atomically, with the first org set active.
- **AC-4**: Assigning an **existing** account to org(s) adds the memberships **directly** (no email/accept), skips duplicates, and is audited.
- **AC-5**: A **CSV** of `email,role[,org]` is previewed with each row's resolved org(s) (domain-matched when no org is given) and any unresolved rows flagged, before the owner confirms; then invitations are created in bulk, deduped and rate-limited.
- **AC-6**: Every provisioning surface (console, existing-user assign, CSV) is **platform-owner only**; a non-owner is refused server-side. The per-org `invitation` flow for org admins is unchanged.
- **AC-7**: No cross-org data leak: the domain lookup and provisioning act only on organizations and memberships; a provisioned member sees only the orgs they were added to. Migrations are additive (no rebuild of `organization`, gotcha #9).

## Decision

**Chosen approach**: a platform-owner **provisioning console** on top of the existing invite → accept flow, with an org → domain map sourced from each org's verified Microsoft domains.
- `org_domains` table (verified domains; O365-fetched or manual), unique per domain, consumer-domain blocklist.
- A `provision` record carrying a **multi-org assignment list**, so one email/accept yields N memberships; its accept reuses `acceptInvite`'s account-creation logic (extracted into shared helpers).
- Direct membership insert for existing accounts; CSV bulk with a confirm-preview.
- All new surfaces gated by `isPlatformOwner`; org-admin per-org invitations untouched.

**Rejected**: silent domain auto-join (the owner wants to confirm); letting org admins assign across orgs (weakens the isolation boundary — cross-org is platform-owner only); a separate DNS TXT domain-verification (redundant when the org's Microsoft tenant already verified the domain).

## Feature design

**Data model** — additive tables (create-only migration; `organization` never rebuilt, gotcha #9):

| Table | Fields | Notes |
|---|---|---|
| `org_domains` | `id` pk, `org_id` FK→organization (cascade), `domain` (unique, lowercased), `source` ('o365'\|'manual'), `verified_at`, `created_at` | One org per domain. Consumer domains rejected. |
| `provision` | `id` pk, `email` (lowercased), `status` ('pending'\|'accepted'\|'cancelled'), `expires_at`, `assignments` (JSON `[{orgId, role}]`), `created_by` FK→user, `created_at` | One email, one accept, N memberships. |

**Domain source** (`src/server/graph.ts`): `getVerifiedDomains(creds)` → `GET /domains`, return the `id`s where `isVerified`. Called from the O365 credentials route (`.../o365/credentials`) after a successful Save & test, upserting `org_domains` (source `o365`); a "Refresh domains" action repeats it. Manual add/remove for non-O365 orgs. A `CONSUMER_DOMAINS` blocklist guards matching and claiming.

**Provisioning core** (new `src/server/provisioning.ts`): `resolveOrgsForEmail(email)` (domain → org via `org_domains`, minus consumer domains); `createProvision({email, assignments, createdBy})` (validates orgs/roles, dedupes against existing members + pending invites/provisions, emails the accept link via `inviteEmail`); `acceptProvision({invitationId, name, password})` — reuses helpers extracted from `invitations.ts`:
- `createOrOnboardUser(db, email, name, password)` — the account-creation/re-onboard block from `acceptInvite`.
- `addMembership(db, userId, orgId, role)` — insert-if-absent membership.
Then all `assignments` + audit rows commit in one `db.batch()`, first org set active.

**Existing-user assign** (`src/server/members.ts` + route): `assignExistingUser({email, assignments, actorUserId})` — find the user, insert each membership (skip duplicates), audit `member.added`. No email.

**Bulk CSV** (`provisioning.ts` + route): parse `email,role[,org]`; `previewCsv` resolves each row (domain-match when no org, flag unresolved/duplicates); `commitCsv` creates provisions for confirmed rows (rate-limited, deduped).

**UI** — a platform-owner **Provisioning** surface (Settings section or `/admin/provisioning`), shown only when `isPlatformOwner`: provision-a-user form (email → pre-selected org, editable multi-org + roles), existing-user assign, CSV upload with preview. Org-domain management (view/add/remove/refresh) lives under each org (platform owner) and is auto-populated from O365.

**Key invariants**:
- Accounts are still created only via invite → accept; admins never set passwords.
- A domain belongs to at most one org; consumer domains never match.
- Cross-org / multi-org assignment is platform-owner only; org-admin invites stay per-org.
- Memberships for a provision are added atomically on accept (one `db.batch()`).

**Security model**: unchanged isolation (spec 0002/0012). The new cross-org surfaces are platform-owner-gated at the route (`isPlatformOwner`) and audited; the domain map exposes only org identity for a domain, never another org's data. Verified domains come from Microsoft's proof, so an org cannot claim a domain it does not own.

**Configuration required**: none new (reuses `O365_CRED_KEK`, `PLATFORM_OWNER_EMAILS`, `RESEND_API_KEY`).

**Critical test scenarios**:
- Domain uniqueness + consumer blocklist; `getVerifiedDomains` parses `/domains` (mock). Verifies **AC-1**.
- Email → pre-selected org; override adds a second org; nothing created until confirm. Verifies **AC-2**.
- Accept a multi-org provision → account + all memberships in one batch, first active. Verifies **AC-3**.
- Assign existing user → memberships inserted, duplicates skipped, no email. Verifies **AC-4**.
- CSV preview resolves domains + flags unresolved; commit creates deduped invites. Verifies **AC-5**.
- A non-platform-owner is refused on every provisioning route. Verifies **AC-6**.

## Migration plan

Additive: create `org_domains` + `provision`. No backfill (domains populate as orgs (re)save O365 or are added manually). Apply `--local` then `--remote`.

## Build plan

1. `org_domains` + `provision` tables + migration; `getVerifiedDomains` in `graph.ts`; fetch on O365 save. Satisfies **AC-1**.
2. `provisioning.ts` core + shared helpers refactored out of `invitations.ts`; the provision accept route. Satisfies **AC-2, AC-3**.
3. Existing-user assign (`members.ts` + route); CSV preview/commit. Satisfies **AC-4, AC-5**.
4. Platform-owner Provisioning UI + org-domain management, all `isPlatformOwner`-gated. Satisfies **AC-6**.
5. Tests per Critical test scenarios.

## Consequences

**Positive**: fast, correct onboarding; domain suggestion removes guesswork; existing users and whole companies handled; account-creation security unchanged.
**Negative / tradeoffs**: a new provisioning surface + a `provision` accept flow parallel to `invitation` (mitigated by sharing the account-creation helpers); the platform owner becomes the onboarding bottleneck (intended — org admins still invite into their own org).
**Neutral**: verified domains only populate for O365-configured orgs (others use manual domains or plain per-org invites).

## Follow-up (roadmap — separate specs)

- [ ] **spec 0015 — SCIM 2.0**: Entra/Okta pushes user create/update/deactivate (auto onboarding + offboarding).
- [ ] **spec 0016 — SSO (SAML/OIDC) + JIT**: corporate sign-in via the org's IdP, account created + assigned on first login.
- [ ] Groups/teams within an org; guest/external users; request-to-join + approval; per-org seat limits (with plans/billing).
