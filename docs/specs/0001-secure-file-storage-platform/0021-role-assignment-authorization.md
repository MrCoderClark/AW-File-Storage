# 0021. Authorization hardening — owner-role assignment & privileged-target guardrails

**Date**: 2026-09-07
**Status**: Proposed

## Summary

The member-management API lets an **admin** grant and revoke the **owner** role and act
on existing owners. `PATCH /api/members/[id]` and `DELETE /api/members/[id]` are gated by
`requireApiRole("admin")`, and the service in `src/server/members.ts` (`changeMemberRole`,
`setMemberStatus`, `removeMember`) enforces only two guards: you can't act on **yourself**,
and you can't demote/suspend/remove the **last active owner**. Nothing stops an admin from
**promoting any member (or a second account they control) to `owner`**, or from demoting,
suspending, or removing an existing owner (as long as one owner remains). That is a
vertical privilege-escalation path: admin → mint an owner they control → full owner
authority (which includes org rename/delete). This spec restricts owner-level changes to
owners and forbids admins from acting on owner accounts.

## Context

Verified in the current code:

- `src/app/api/members/[id]/route.ts` — `PATCH` and `DELETE` both call
  `requireApiRole("admin")`. The body's `role` is validated only against the set
  `["owner","admin","member"]`, so `"owner"` is an accepted target role.
- `src/server/members.ts`:
  - `changeMemberRole` blocks changing **your own** role and blocks demoting the **last
    active owner**, but otherwise applies any `newRole` — including `owner` — to any
    other member. An admin can promote a member to owner.
  - `setMemberStatus` and `removeMember` block self-action and last-active-owner, but an
    admin can suspend or remove a **non-last** owner.
- `owner` is the top org role (`RANK` in `src/server/session.ts`) and gates
  `DELETE /api/organization` (org deletion, `requireApiRole("owner")`) and org rename.
  So minting an owner is equivalent to handing out the org's destroy button.

Why it matters: admins are semi-trusted, but the role model clearly intends `owner` to be
a strictly higher tier than `admin` (org create/delete is owner/platform-owner only,
spec 0012). An admin being able to manufacture an owner collapses that tier. This is a
**business-logic / broken-access-control** finding (OWASP A01). It requires an
authenticated admin, so it is **Medium**, not Critical — but it is a real escalation, not
theoretical.

This spec does **not** change the platform-owner tier (spec 0012, `isPlatformOwner`),
org create/delete gating, or cross-org isolation — those are correct.

## Requirements

**User stories**:
- As an owner, I want to be the only role that can create another owner or change an
  owner's role, so an admin cannot promote themselves (via a second account) to my level.
- As an owner, I want admins unable to suspend, demote, or remove an owner, so a rogue or
  compromised admin can't dismantle ownership.
- As an admin, I keep full management over `member` and `admin` accounts, so day-to-day
  administration is unaffected.

**Acceptance criteria**:
- **AC-1 (only owners grant owner)**: `changeMemberRole` rejects `newRole === "owner"`
  unless the **acting caller is an owner**. An admin attempting to promote anyone to
  owner gets `403`. (The route already resolves the caller's role via
  `requireApiRole`; the acting role must be threaded into the service so it can enforce
  this — the service must not infer authority from the target alone.)
- **AC-2 (only owners change an owner)**: `changeMemberRole`, `setMemberStatus`, and
  `removeMember` reject any action whose **target is currently an owner** unless the
  acting caller is an owner. An admin acting on an owner gets `403`. Owners may still act
  on other owners subject to the existing last-active-owner guard.
- **AC-2b (only owners take over an owner account)**: The account-security actions that
  could take over or weaken an owner account — `adminSetPassword` (an admin could set an
  owner's password and then sign in as them), `sendMemberResetLink` (returns a usable
  reset link to the admin), `revokeMemberSessions`, and `resetMemberTwoFactor` — likewise
  reject a non-owner caller acting on an owner target (`403`). Without this, AC-1/AC-2
  would be moot: an admin who can reset an owner's password already owns the account.
  Enforced via a shared `assertOwnerActionAllowed(actorRole, target)` helper in
  `members.ts`.
- **AC-3 (existing guards preserved)**: The current guards remain — no self-role-change /
  self-status-change / self-removal, and the last-active-owner can't be demoted,
  suspended, or removed. AC-1/AC-2 are layered on top, not replacing them.
- **AC-4 (route validation)**: `PATCH /api/members/[id]` still accepts `role` only from
  `["owner","admin","member"]`; the owner restriction is enforced in the service (server
  side), never only in the UI. The UI (`members-section.tsx` / `member-actions.tsx`)
  should additionally hide the "owner" option and owner-target actions from a non-owner
  caller, but hiding is cosmetic — the server is the gate.
- **AC-5 (audit unchanged in shape)**: Denied attempts return a typed `MemberError(403,…)`
  (consistent with the existing error contract) and are **not** audited as a successful
  change. Successful changes keep their existing audit rows
  (`member.role_changed`, etc.).
- **AC-6 (2FA-required tier note)**: No change to `setMemberTwoFactorRequired` semantics,
  but confirm an admin cannot use any member action as a side channel to owner authority
  (e.g. there is no path where setting a flag escalates a role).

## Decision

**Chosen approach**: thread the **acting caller's role** (already known at the route via
`requireApiRole`) into `changeMemberRole`, `setMemberStatus`, and `removeMember`, and add
two checks in `members.ts`: (1) granting `owner` requires the caller to be an owner;
(2) acting on a target that is currently an owner requires the caller to be an owner. Keep
every existing guard.

**Rejected**:
- Enforcing only in the route handler — the service is the reusable authorization point
  and other callers (future provisioning flows) must inherit the guard; putting it only in
  the route invites a bypass.
- Forbidding admins from all role changes — too broad; admins legitimately manage
  member↔admin transitions and should keep that.
- Hiding the owner option in the UI only — the audit's core rule: never rely on the
  frontend hiding a control; the API must refuse it.

## Feature design

**Signature change.** Add `actorRole: OrgRole` to the option objects of
`changeMemberRole`, `setMemberStatus`, and `removeMember` in `src/server/members.ts`.
The route already has it as `auth.actor.role`; pass it through the existing `base` object
in `src/app/api/members/[id]/route.ts`.

**Checks** (in `members.ts`, after the existing `getMemberInOrg` + self/last-owner
guards):

- In `changeMemberRole`:
  - if `newRole === "owner"` and `actorRole !== "owner"` → `MemberError(403, "Only an
    owner can grant the owner role.")`.
  - if `m.role === "owner"` and `actorRole !== "owner"` → `MemberError(403, "Only an
    owner can change an owner's role.")`.
- In `setMemberStatus` and `removeMember`:
  - if `m.role === "owner"` and `actorRole !== "owner"` → `403`.
- In `adminSetPassword`, `sendMemberResetLink`, `revokeMemberSessions`,
  `resetMemberTwoFactor` (AC-2b): a shared `assertOwnerActionAllowed(actorRole, m)` throws
  `MemberError(403, "Only an owner can manage an owner's account.")` when the target is an
  owner and the caller is not. All four now take `actorRole`, threaded from their routes
  (`/api/members/[id]/password`, `/reset-link`, `/sessions`, `/two-factor`).

**UI (cosmetic, defense-in-depth).** In the members UI, when the current caller is an
admin (not owner), omit "Owner" from the role dropdown and disable suspend/remove/role
controls on rows whose role is `owner`. The server still enforces AC-1/AC-2.

**Key invariants**:
- `owner` can only be granted by an owner, and an owner can only be changed by an owner.
- Every existing guard (self, last-active-owner) still holds.
- Enforcement lives in the service, so all callers inherit it; the UI only mirrors it.

## Verification

See `0021-verify.md`. Unit tests in `test/members.test.ts` (extend the existing suite):
an **admin** actor promoting a member to `owner` → 403; an admin changing an existing
owner's role/status or removing an owner → 403; an **owner** actor doing each of those →
allowed (subject to last-active-owner); the last-active-owner guard still fires; a normal
member↔admin change by an admin still works; org isolation preserved (an admin of org A
cannot touch org B, unchanged). Manual: as an admin, attempt the promote-to-owner API call
directly with `curl` and confirm 403.

## Out of scope (later)

A full permission matrix / policy engine; delegated custom roles; requiring 2FA
re-authentication for owner-tier changes (could be a later step-up-auth spec); notifying
the owner when role changes occur (the audit log already records them, surfaced by
spec 0018).
