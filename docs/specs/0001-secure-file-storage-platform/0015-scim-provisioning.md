# 0015. SCIM 2.0 provisioning (automated onboarding & offboarding)

**Date**: 2026-09-04

## Summary

Provisioning (spec 0014) is a manual console. SCIM 2.0 automates it and, more importantly, automates **offboarding**: a customer's Microsoft Entra becomes the source of truth and **pushes** user create / update / **deactivate** into the app. When someone joins or leaves that company in Entra, their access here updates itself — a leaver is auto-suspended and their sessions revoked. The role flips from everything else built so far: instead of the app calling Microsoft, **the app is a SCIM *server*** that Entra calls, authenticated by a **per-org bearer token**. Because that token can create and deactivate users, security is the driving constraint: the token is **hashed at rest, shown once, rotatable, scoped to exactly one org**, and can do only a narrow set of things (never cross-org, never a role above member, never passwords or data). One product wrinkle: a freshly SCIM-created user's Exchange mailbox in their tenant isn't provisioned instantly, so the "set your password" email is **delayed ~5 minutes**. v1 is **Users only** (Groups deferred).

## Context

Today accounts are created through invite → accept (specs 0005/0014); `member.status` supports `active`/`suspended`, and `setMemberStatus` (`members.ts`) already suspends a membership **and revokes the user's sessions** — the exact primitive SCIM deactivation needs. Per-org O365 (spec 0013) already ties each org to a Microsoft tenant. The runtime is Cloudflare Workers; `isPlatformOwner` / `requirePlatformOwner` (`platform.ts`) gate the platform-owner tier; the companion cron worker (`cron/`) already runs scheduled HTTP calls to bearer-authenticated `/api/cron/*` endpoints. `proxy.ts` enforces an Origin/CSRF check on mutating requests — which a machine SCIM client cannot satisfy.

## Requirements

**User stories**:
- As the platform owner, I want to give a customer a SCIM endpoint + token so their Entra provisions and **deprovisions** users automatically.
- As a security-conscious operator, I want that token to be hashed, one-org-scoped, revocable, and unable to do anything beyond adding/suspending members in its org.
- As an admin at a customer, when I unassign a user in Entra, I want them to **lose access here immediately**.
- As a SCIM-provisioned user, I want to receive a set-password link **once my mailbox exists** (a few minutes after creation), so it doesn't bounce.

**Acceptance criteria**:
- **AC-1**: Each org can have a **SCIM token**: generated/rotated/disabled by the **platform owner** only, **shown once**, stored **hashed**. Presenting the token authenticates SCIM requests and resolves to **exactly that org**.
- **AC-2**: `POST /Users` **creates/onboards the account and adds a `member` membership** in the token's org, and **schedules a set-password email ~5 minutes later** (no immediate send). It never sets a role above member and never sets a password.
- **AC-3**: `PATCH`/`PUT /Users/{id}` updates name/email; `active:false` **suspends** the membership (via `setMemberStatus`, which revokes sessions); `active:true` reactivates. `DELETE /Users/{id}` removes the membership (keeps the account for history).
- **AC-4**: All SCIM reads/writes are **confined to the token's org**. A token can never see or modify another org's users (`GET /Users?filter=userName eq "x"` returns only that org's members); an existing account for another org is only *added a membership*, never hijacked or revealed.
- **AC-5**: SCIM endpoints are exempt from the session/Origin CSRF check (they are bearer-authenticated, not cookie-authenticated, so CSRF does not apply), authenticated solely by the bearer token, HTTPS-only, rate-limited, and **every write is audited** (actor "scim"). Malformed/oversized requests get a clean SCIM 4xx with no info leak.
- **AC-6**: The delayed set-password emails are sent by a **cron flush** (~every 5 minutes); only due, unsent ones go out, each with a freshly minted reset link. Migration is additive (no rebuild of `organization`, gotcha #9).

## Decision

**Chosen approach**: implement a SCIM 2.0 **Users** server under `/api/scim/v2`, authenticated by a per-org hashed bearer token, reusing the existing membership/suspension/onboarding primitives; defer the set-password email via a `pending_email` table flushed by a new 5-minute cron trigger.

**Rejected**:
- *Passwordless / SSO-only accounts* — no SSO yet (spec 0016); a set-password email bridges to the existing auth. *Immediate* email rejected because the mailbox isn't ready → delayed.
- *Org id in the SCIM URL* — the token alone resolves the org (no org id in the path), avoiding enumeration; one token = one org.
- *Org admins generating tokens* — these tokens deprovision users; minting them stays platform-owner only.
- *SCIM Groups in v1* — role/team mapping is a meaningful surface; deferred.

## Feature design

**Data model** — additive tables (create-only migration; `organization` never rebuilt, gotcha #9):

| Table | Fields | Notes |
|---|---|---|
| `scim_token` | `org_id` PK/FK→organization (cascade), `token_hash`, `active` bool, `created_by` FK→user, `created_at`, `last_used_at` | One SCIM config per org; the hash maps a presented token to the org. |
| `pending_email` | `id` pk, `kind` ('scim_set_password'), `user_id` FK→user, `org_id`, `send_after`, `sent_at` null, `created_at` | Deferred email queue; flushed by cron. |

**Token** (`src/server/scim.ts` + a hashing helper): a token is a long random string (e.g. `scim_` + 32 random bytes base64url). Only its **SHA-256 hash** is stored. Auth: hash the presented bearer, look up `scim_token` by hash (active) → org, touch `last_used_at`. Generate/rotate/disable are platform-owner actions.

**SCIM server** (`src/app/api/scim/v2/**`): a thin bearer-auth layer + org-scoped handlers.
- **Discovery (static JSON):** `GET /ServiceProviderConfig`, `/ResourceTypes`, `/Schemas` — what Entra fetches to learn capabilities (patch supported, filter supported, no password, no bulk).
- **`/Users`:** `GET` (list, honoring `filter=userName eq "email"` for the existence check Entra does before create), `GET /{id}`, `POST` (create), `PATCH /{id}` + `PUT /{id}` (update / active flag), `DELETE /{id}`. SCIM JSON shape: `schemas`, `id` = userId, `userName` = email, `name.givenName`/`familyName` (split from `user.name`), `active` (derived from the org membership's status), `meta`.
- Mapped to primitives: create → onboard account (random unusable password) + `member` membership + queue delayed email; active:false → `setMemberStatus` suspended; active:true → active; DELETE → `removeMember`. Every write audited (actor "scim").

**CSRF exemption** (`src/proxy.ts`): `/api/scim/*` bypasses the Origin check — bearer-authenticated, not cookie, so CSRF is not applicable. Documented inline as a deliberate, safe exemption.

**Delayed set-password email**: on create, insert `pending_email` (`send_after = now + SCIM_WELCOME_DELAY_MIN`, default 5). New `POST /api/cron/flush-emails` (bearer `CRON_SECRET`) selects due unsent rows and, per row, initiates a **password reset** for the user (Better Auth reset, rendered with the branded `linkEmail`) so the token is fresh, then marks `sent_at`. The companion cron worker gains a `*/5 * * * *` trigger, branching on `event.cron`.

**Token management UI** (platform owner, in the org's Settings near O365): Generate (shows base URL + secret once), Rotate, Disable, last-used. `/api/scim-config/*` behind `requirePlatformOwner`.

**Key invariants**:
- A SCIM token authenticates to exactly one org and can only add/suspend/remove **member** memberships + update profile there; never cross-org, never role ≥ admin, never passwords/data.
- Account creation still yields a user who sets their **own** password (via the delayed email); the app never holds it.
- Suspension revokes sessions immediately (reused `setMemberStatus`), so deprovisioning is effective at once.

**Security model**: the token is the sensitive credential — hashed at rest, one-org scope (leak blast radius = one org), least privilege, audited, rate-limited, HTTPS. SCIM cannot be used to escalate a role, read another org, or exfiltrate data; the worst a leaked token does is create/suspend members in its own org (recoverable by rotating the token + reviewing the audit log). This is a *new inbound* attack surface, mitigated by narrow capability + strong auth.

**Configuration required**: `SCIM_WELCOME_DELAY_MIN` (default 5) — optional. Reuses `CRON_SECRET`, `RESEND_API_KEY`, `BETTER_AUTH_SECRET`.

**Critical test scenarios**:
- Token hash/verify: a generated token authenticates and resolves to its org; a wrong/rotated token 401s. Verifies **AC-1**.
- Create: `POST /Users` onboards account + `member` membership + **queues** a delayed email (nothing sent now). Verifies **AC-2, AC-6**.
- Deactivate: `PATCH active:false` suspends the membership and revokes sessions; `active:true` restores. Verifies **AC-3**.
- Isolation: org A's token cannot read or modify an org-B user; a `filter` query returns only A's members. Verifies **AC-4**.
- Hardening: no Origin header still succeeds (bearer); a bad body → SCIM 4xx; every write audited. Verifies **AC-5**.
- Flush: only due, unsent `pending_email` rows are sent, each once. Verifies **AC-6**.

## Migration plan

Additive: create `scim_token` + `pending_email` (migration 0018). No backfill. Apply `--local` then `--remote`. Add the `*/5 * * * *` trigger to the cron worker and redeploy it (separate from the app deploy).

## Build plan

1. `scim_token` + `pending_email` tables + migration; token hashing helper. Satisfies **AC-1** (storage).
2. `scim.ts`: token auth + org resolution; user mapping; create/update/suspend/delete via reused primitives; audits. Satisfies **AC-2, AC-3, AC-4**.
3. `/api/scim/v2/**` routes (discovery + Users) + `proxy.ts` exemption + rate limit. Satisfies **AC-5**.
4. `pending_email` + `/api/cron/flush-emails` + cron worker `*/5` trigger. Satisfies **AC-6**.
5. Platform-owner token UI + `/api/scim-config/*`.
6. Tests per Critical test scenarios.

## Consequences

**Positive**: true automated onboarding **and offboarding** (the leaver problem solved); each customer self-serves via their own IdP; reuses membership/suspension/onboarding primitives.
**Negative / tradeoffs**: a new inbound authenticated surface to keep hardened; the platform custodies a powerful per-org token (hashed, rotatable); a 5-minute onboarding-email delay (deliberate, for mailbox readiness); a new frequent cron trigger.
**Neutral**: SCIM users authenticate by setting their own password until SSO (spec 0016) lets them use their corporate identity; v1 maps everyone to member (promotion stays manual).

## Follow-up (roadmap — separate specs)

- [ ] **spec 0016 — SSO (SAML/OIDC) + JIT**: corporate sign-in; pairs with SCIM so provisioned users log in with their IdP.
- [ ] SCIM **Groups → roles/teams** mapping.
- [ ] Per-org **seat limits** (with plans/billing).
