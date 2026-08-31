# 0005. User management: roster, account lifecycle, and self service password reset

**Date**: 2026-08-28

## Summary

Admins currently have no way to see or manage the people in their organization. The backend can create and accept an invitation, but nothing in the app calls it, and the link the invitation email sends people to does not exist as a page, so nobody can actually join. This spec adds a Members section inside Settings: a roster of everyone in the organization, a per person detail page, invitations you can send, revoke, and resend, and the account actions an admin is actually asked for (suspend, reactivate, change role, remove, revoke sessions, reset a lost second factor). It also adds the two missing self service pages so a person who forgets their password can fix it without asking an admin. Suspension is stored as a `status` field on the organization membership row, so it applies per organization and no new authentication plugin is needed.

## Context

> ⚠️ Premise note: invitations are broken in production right now, not merely unbuilt. `createInvite` emails a link to `${APP_URL}/accept-invitation/<id>` (`src/server/invitations.ts`), and no page serves that path, so every invitation sent so far has landed on a 404. Any plan that treats this feature as new capability is mis reading it: the first slice is a repair, and until it lands the organization cannot grow past the accounts seeded by hand through `/api/admin/bootstrap`.

> ⚠️ Premise note (scope): this topic spans three surfaces that could each be their own spec (the roster plus lifecycle, invitation acceptance, and self service password reset). They are kept together here because all three read or write the same two rows (`member` and `invitation`), all three are gated by the same role rules, and splitting them would mean three specs that cannot be built independently anyway. If the roster grows a second axis later (for example cross organization administration), split that out rather than growing this spec.

The organization plugin already gives us `organization`, `member`, and `invitation` rows, and `requireOrgRole` already reads a caller's role from the membership and forces owners and admins through second factor enrolment. What is missing is every read and every write a human needs: there is no endpoint that lists members, none that changes a role, none that removes anyone, and no screen for any of it. `src/app/(app)/settings/page.tsx` is a stub that promises member management and delivers a "coming soon" panel.

Two constraints shape the design. First, spec 0002 already decided that a departing person is disabled rather than deleted, because `file.uploaded_by`, `file_version.uploaded_by`, `audit_event.actor_user_id`, and `file.deleted_by` all reference `user` without cascade, so history depends on that row surviving. Deleting a user is therefore not an option the schema permits. Second, Better Auth owns the `user` and `member` tables, and the project rule is to configure Better Auth rather than reimplement or bypass it, so any new flag has to arrive through a supported extension point.

The data is personal data: staff names, work email addresses, sign in times, and the contact details in the vCards they publish. No formal compliance standard is named in `AGENTS.md`, but the audit obligation from the umbrella contract applies in full, and access control changes are exactly the class of mutation that must leave a durable record.

## Requirements

**User stories**:
- As an invited staff member, I want the link in my invitation email to work, so that I can set a password and start using the app.
- As an admin, I want to see everyone in my organization with their role and status, so that I know who has access.
- As an admin, I want to suspend someone who has left or is on leave, so that they cannot sign in, without destroying the files they uploaded.
- As an admin, I want to see why somebody cannot sign in (locked out, no second factor, no active session), so that I can help them without guessing.
- As a staff member, I want to reset my own forgotten password, so that I do not have to wait for an admin.

**Acceptance criteria**:

- **AC-1**: An invited person opening `/accept-invitation/<id>` can set a name and password and lands signed in, holding the role the invitation named. An invitation that is invalid, expired, or already used shows a plain message and creates no account.
- **AC-2**: An owner or admin sees a roster of every member of the active organization with name, email, role, status (active or suspended), and joined date. A caller whose role is `member` cannot reach the roster page or any of its endpoints and receives 403.
- **AC-3**: Pending invitations are listed separately with email, role, and expiry, and each can be revoked or resent. Revoking sets the invitation status to `cancelled`. Resending issues a fresh invitation and invalidates the previous link.
- **AC-4**: An owner or admin can change any member's role, including another owner's, and the new role governs that member's very next request.
- **AC-5**: The last active owner of an organization cannot be suspended, removed, or demoted. The attempt fails with 409 and a message naming the reason.
- **AC-6**: Nobody can suspend, remove, or change the role of their own account. The attempt fails with 409.
- **AC-7**: Suspending a member sets `member.status` to `suspended` and revokes every one of that user's sessions in the same action. A suspended person's sign in attempt is refused with "Your access has been suspended. Contact your administrator."
- **AC-8**: Reactivating a member restores access with the role they already held. No new invitation is needed.
- **AC-9**: Removing a member deletes only the membership row. The `user` row, their files, every `uploaded_by` reference, and any contact card they published are untouched, and published cards stay live at the same address.
- **AC-10**: `/settings/users/<id>` shows sign in state (last sign in, count of active sessions, failed attempt count and locked until from `account_lock`), storage footprint (files uploaded, total bytes, number currently published), and security posture (whether a second factor is enrolled, when, and how many backup codes remain).
- **AC-11**: An owner or admin can revoke all of a member's sessions, and can reset a member's second factor so that the member must enrol again on next sign in.
- **AC-12**: Every state change in this feature writes exactly one `audit_event` row, carrying actor, action, target, and IP, before the success response returns.
- **AC-13**: A signed out person can request a reset at `/forgot-password` and complete it at `/reset-password`, reached from a link on the sign in page. The response to a request is identical whether or not the email exists.
- **AC-14**: Every roster, detail, and invitation query filters on the active organization taken from the session. No member, invitation, or user of another organization is ever returned or mutable, including by passing another organization's member id directly.
- **AC-15**: The roster and pending invitation endpoints paginate, defaulting to 50 rows with a cursor for the next page.
- **AC-16**: Resend and password reset requests are rate limited per organization and per email, and a caller exceeding the limit receives 429.
- **AC-17**: The roster, the pending list, and the detail page each have a loading, empty, and error state. Every action is reachable by keyboard, and suspend, remove, revoke, and reset each require an explicit confirmation naming the person.

## Options considered

The real fork was how to represent a disabled account, since the schema forbids deleting the user row.

### Option 1: a `status` field on the membership row

Add `status` (`active` or `suspended`) to `member` through the organization plugin's `schema.member.additionalFields`, the same extension point that already carries `storageQuotaBytes` on `organization`.

**Pros**:
- Uses a pattern already proven in `src/server/auth-options.ts`, so the schema stays generated rather than hand edited.
- The flag is organization scoped, so a suspension in one organization does not follow the person into another.
- `input: false` means no client can ever set it.

**Cons**:
- Suspension has to be checked in our own sign in hook, because Better Auth has no concept of it.
- One more migration on a Better Auth owned table.

### Option 2: the Better Auth admin plugin

Install the official `admin` plugin, which brings `banned`, `banReason`, and `banExpires` on `user`, plus `listUsers`, `setRole`, and `revokeUserSessions`.

**Pros**:
- Most aligned with "do not reimplement Better Auth primitives": ban and session revocation come ready made and tested.
- Its list and revoke APIs would replace endpoints we would otherwise write.

**Cons**:
- The ban is global, not per organization, which contradicts the isolation model in spec 0002.
- It introduces a second, global `role` on `user` that overlaps confusingly with the organization roles `requireOrgRole` already reads.
- It ships impersonation, a capability nobody asked for, that would have to be switched off deliberately.

### Option 3: membership removal only

Treat suspend and remove as the same act: delete the `member` row, since `requireOrgRole` already denies anyone without a membership.

**Pros**:
- No migration and no new field.
- Cannot drift out of sync with the authorization check, because there is only one fact.

**Cons**:
- Loses the difference between "on leave, restore them later with the role they had" and "gone", which was an explicit requirement.
- A suspended person cannot be shown in the roster at all, so the admin has no record that they ever existed without reading the audit log.

## Decision

**Chosen option**: Option 1, a `status` field on the membership row.

Add `status` to `member` through the organization plugin's `additionalFields`, treat suspension as organization scoped, revoke sessions as part of the same action, and check membership status in the existing sign in hook so a suspended person is refused at the door. Everything else reuses what is already there: Better Auth's own APIs for session revocation and password reset, `requireOrgRole` for gating, the audit helper for the record, and route handlers plus client fetch for the API, matching `src/components/file-manager.tsx`.

Placement and shape, as chosen: a Members section inside `/settings` (not a new top level tab), with a full page per person at `/settings/users/<id>` rather than a drawer.

Role rules, as chosen: any owner or admin may act on anyone, including other owners. The only structural limits are the last active owner guard and the self action guard. Removal keeps every file and leaves published cards live. Password reset is self service only, with no admin triggered reset button. **(Amended after shipping — admin Set password and Send reset link were added by request; see [Amendments](#amendments).)**

**Implementation skills**: `tailwindcss-v4` (`C:\Users\jclark\.agents\skills\tailwindcss-v4\`) · `frontend-design` (`C:\Users\jclark\.agents\skills\frontend-design\`) · `playwright` (`C:\Users\jclark\.agents\skills\playwright\`) · `powershell-windows` (`C:\Users\jclark\.codeium\windsurf\skills\powershell-windows\`)

## Rationale

The schema decided most of this before the conversation started. Because four columns reference `user` without cascade so that history survives (spec 0002), removing a person can only ever mean removing their membership, which makes a per membership flag the natural home for "suspended" too: one row, one organization, one fact about access. The admin plugin was the tempting alternative on the "configure, do not reimplement" rule, but its ban is global, and a global ban in an app whose entire data model is organization scoped is a contradiction that would surface the first time one person belongs to two organizations. Reusing the plugin's own extension point keeps the schema generated by its CLI, which is the flow `AGENTS.md` documents, so the cost is one migration rather than a hand edit.

Two of the choices trade safety for speed, and both are deliberate. Letting any admin act on any owner is the weakest of the containment options offered: a single compromised admin account can demote or suspend every owner, and the last owner guard is then the only thing standing between that attacker and an organization nobody can administer. That is acceptable on a small internal team where every admin is already trusted with the contact data itself, but it is the first thing to revisit if the admin count grows beyond a handful, so it is recorded in Follow up rather than buried. Similarly, self service only password reset means an admin cannot help someone whose email access is itself the problem; the mitigation is that such a person is a phone call away from an owner who can suspend and re invite them under a working address.

Keeping the roster in Settings rather than a new top level tab was the engineer's call and it does mean a member management screen sits behind a nav item labelled Settings, which is slightly less discoverable. It also keeps the primary nav at three tabs, and the stub page already promised members, so the promise is simply kept.

## Feature design

**Data model sketch**:

Only one schema change. Everything else reads rows that already exist.

| Table | Field | Type | Required | Notes |
|---|---|---|---|---|
| `member` (Better Auth, organization plugin) | `status` | text, `active` or `suspended` | yes, default `active` | New. Added via `schema.member.additionalFields` with `input: false`. Regenerate with the Better Auth CLI, then `drizzle-kit generate`. |

Rows read but not changed: `user` (name, email, `twoFactorEnabled`, `createdAt`), `member` (`role`, `createdAt`, `organizationId`, `userId`), `invitation` (`email`, `role`, `status`, `expiresAt`, `inviterId`), `session` (for active count and last sign in), `account_lock` (`failedCount`, `lockedUntil`, `lockLevel`), `twoFactor` (enrolment and remaining backup codes), `file` (aggregate count, bytes, published count by `uploaded_by`).

Derived values are computed at read time, never stored: the storage footprint is a `SUM`/`COUNT` over `file` filtered by `org_id` and `uploaded_by`, and the active session count is a `COUNT` over non expired `session` rows.

**State transitions**:

Membership: `active` ⇄ `suspended`, and either state can end in removal (the row is deleted, which is terminal because a returning person is re invited rather than restored).

- `active` → `suspended`: an owner or admin suspends. Side effect in the same action: revoke all sessions for that user.
- `suspended` → `active`: an owner or admin reactivates. The role is untouched throughout, which is what makes AC-8 free.
- either → removed: membership row deleted. Files, `uploaded_by`, and published cards untouched (AC-9).

Invitation (already exists, now driveable from the UI): `pending` → `accepted` on use, `pending` → `cancelled` on revoke, `pending` → expired by time. Resend is modelled as `cancelled` plus a new `pending` row, so the old link stops working.

**API surface**:

| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/members` | GET | `cursor`:string (opt), `limit`:number (opt, default 50) | `members[]` (id, userId, name, email, role, status, joinedAt), `nextCursor` | owner or admin | 401, 403 |
| `/api/members/[id]` | GET | none | member plus signInState, storageFootprint, securityPosture | owner or admin | 401, 403, 404 |
| `/api/members/[id]` | PATCH | `role`:"owner"\|"admin"\|"member" (opt), `status`:"active"\|"suspended" (opt) | ok, member | owner or admin | 400 invalid, 403, 409 last owner or self action |
| `/api/members/[id]` | DELETE | none | ok | owner or admin | 403, 409 last owner or self action |
| `/api/members/[id]/sessions` | DELETE | none | ok, `revoked`:number | owner or admin | 403, 404 |
| `/api/members/[id]/two-factor` | DELETE | none | ok | owner or admin | 403, 404 |
| `/api/invitations` | GET | `cursor`, `limit` (opt) | `invitations[]` (id, email, role, expiresAt), `nextCursor` | owner or admin | 401, 403 |
| `/api/invitations` | POST | exists already: `email`, `role` | ok, invitationId | owner or admin | 400, 403, 409 already member or pending |
| `/api/invitations/[id]` | DELETE | none | ok | owner or admin | 403, 404 |
| `/api/invitations/[id]/resend` | POST | none | ok, new invitationId | owner or admin | 403, 404, 429 |

Pages: `/settings` (Members section), `/settings/users/[id]` (detail), `/accept-invitation/[id]` (public), `/forgot-password` (public), `/reset-password` (public, token in the query string). The sign in page gains a "Forgot password?" link, which was deliberately left out when it had nowhere to go.

Password reset uses Better Auth's own endpoints through `authClient`, not new routes of ours, because `sendResetPassword` is already configured in `src/server/auth.ts` and its rate limiting and enumeration protection come with it.

**Key invariants**:

1. Every organization always has at least one owner whose `member.status` is `active`. Enforced in the service layer before any role change, suspension, or removal (AC-5).
2. A caller can never suspend, remove, or re role their own membership (AC-6).
3. `member.status` is only ever written by the server. `input: false` on the field means Better Auth will not accept it from a client payload.
4. Suspension and session revocation happen together. A `member` row reading `suspended` while that user holds a live session is a bug.
5. Every mutation writes exactly one `audit_event`, before the success response, using these action names: `member.invited`, `member.invite_revoked`, `member.invite_resent`, `member.joined`, `member.role_changed`, `member.suspended`, `member.reactivated`, `member.removed`, `member.sessions_revoked`, `member.two_factor_reset`. `targetType` is `member` or `invitation`; `targetId` is that row's id; `metadata_json` carries the before and after values for a role change.
6. Removing or suspending a person never touches `file`, `file_version`, or the public bucket. No published contact card changes state as a side effect of a membership change.
7. Every query in this feature is filtered by the organization id taken from `session.activeOrganizationId`, never from the request. `member` and `invitation` are Better Auth tables rather than our tenant tables, so `orgDb` does not cover them: the organization filter is written explicitly in every one of these queries, and the member id from the URL is only ever resolved *within* that organization (AC-14).

**Security model**:

- **Read the roster or a detail page**: role `owner` or `admin`, through `requireOrgRole("admin")`. Role `member` gets 403 from the endpoints and cannot render the page.
- **Every mutation**: role `owner` or `admin`, and because `requireOrgRole` already redirects owners and admins to `/enroll-2fa` until a second factor exists, every mutation in this feature is implicitly behind a second factor. That is intended and should not be worked around.
- **Act on whom**: any owner or admin may act on any member, admin, or owner, bounded only by invariants 1 and 2. This is the loosest option that was on the table and it is a conscious acceptance.
- **Public pages**: `/accept-invitation/<id>`, `/forgot-password`, and `/reset-password` are reachable while signed out. The invitation id is the only capability that authorizes account creation, so it must stay unguessable (it is a UUIDv7 today) and single use, and the page must never reveal the invited email address to a caller holding a wrong id.
- **Enumeration**: the reset request response never varies on whether the email exists (AC-13). The roster is the one place a signed in admin legitimately sees every email in their own organization.
- **Personal data**: names, work emails, sign in times, and lockout state. Every access control change is audited (AC-12), which is the non negotiable part of the umbrella contract, not a nice to have.

**Configuration required**:

None. No new environment variable, secret, or third party account. `RESEND_API_KEY`, `EMAIL_FROM`, and `APP_URL` are already set and already used by the invitation and reset emails.

**Critical test scenarios**:

- Happy path: an owner invites an email, the invitee opens the emailed link, sets a name and password, and appears in the roster as an active member with the invited role, verifies **AC-1**, **AC-2**, **AC-3**.
- Happy path: an admin suspends a member, that member's live session stops working on the next request, and their sign in attempt is refused with the suspension message; reactivating restores the same role, verifies **AC-7**, **AC-8**.
- Failure case: the last active owner tries to demote, suspend, or remove themselves, and each attempt returns 409 with the organization intact, verifies **AC-5**, **AC-6**.
- Failure case: removing a member who published contact cards leaves every card live at its original address and every `uploaded_by` reference unchanged, verifies **AC-9**.
- Auth or permission: a caller whose role is `member` receives 403 from every endpoint listed above and cannot render the Members section, verifies **AC-2**.
- Auth or permission: an owner of organization A passes a member id belonging to organization B to `PATCH` and `DELETE` and receives 404, with organization B unchanged, verifies **AC-14**.
- Failure case: an admin resends the same invitation repeatedly and is rate limited with 429 after the threshold, and the previously emailed link no longer works after a resend, verifies **AC-3**, **AC-16**.

## Build plan

No build approach is recorded in `AGENTS.md`, so this plan assumes end to end vertical slices: each numbered slice goes through migration, service, endpoint, and screen, and leaves the app working and demonstrable. The ordering puts the repair first, because invitations being dead is the most expensive thing on this list.

1. Add `status` to `member` via `schema.member.additionalFields` in `src/server/auth-options.ts`, regenerate the Better Auth schema with its CLI, `drizzle-kit generate`, and apply to local and remote D1. Satisfies **AC-7** groundwork.
2. Build `/accept-invitation/[id]`: a public page that resolves the invitation, collects name and password, calls the existing `acceptInvite`, signs the person in, and writes `member.joined`. Handles invalid, expired, and already used. Satisfies **AC-1**, **AC-12**.
3. Build the roster read path end to end: a member service with an explicit organization filter, `GET /api/members` with cursor pagination, and the Members section in `/settings` with loading, empty, and error states. Satisfies **AC-2**, **AC-14**, **AC-15**, **AC-17**.
4. Wire invitations into the UI: `GET /api/invitations`, the invite form calling the existing `POST`, `DELETE /api/invitations/[id]` to revoke, and `POST /api/invitations/[id]/resend` (cancel plus recreate) with rate limiting. Satisfies **AC-3**, **AC-12**, **AC-16**.
5. Add role change and removal: `PATCH` and `DELETE /api/members/[id]`, the last active owner guard, the self action guard, confirmation dialogs, and audit rows. Satisfies **AC-4**, **AC-5**, **AC-6**, **AC-9**, **AC-12**.
6. Add suspension: `PATCH` with `status`, session revocation in the same action, the sign in refusal in the existing `before` hook in `src/server/auth.ts` (and picking an active membership in the session `create` hook), and reactivation. Satisfies **AC-7**, **AC-8**, **AC-12**.
7. Build the detail page `/settings/users/[id]` with `GET /api/members/[id]`: sign in state, storage footprint aggregates, security posture, plus the revoke sessions and reset second factor actions. Satisfies **AC-10**, **AC-11**, **AC-12**, **AC-17**.
8. Build self service password reset: `/forgot-password` and `/reset-password` on Better Auth's own endpoints, and add the "Forgot password?" link to the sign in page. Satisfies **AC-13**.
9. Tests: Vitest with real bindings for the guards, the organization isolation cases, and the audit rows; Playwright for the invite to accept to roster journey and the suspend to refused sign in journey. Covers every AC above.

## Consequences

**Positive**:
- Invitations start working, so the organization can actually be staffed without a bootstrap call and a hand written SQL insert.
- Access control changes become visible and reversible instead of being database surgery.
- The audit log gains the category it was missing: who granted and revoked access, not just who touched files.
- Self service reset removes the most common support request before it is ever filed.
- Suspension gives a safe answer to "someone left today" that does not risk the files or the public card addresses they left behind.

**Negative or tradeoffs**:
- Any single admin can demote or suspend every owner. The last active owner guard prevents total lockout but not disruption, and a compromised admin account is now materially more damaging than it was.
- No admin can help a person whose email access is broken, because reset is self service only and there is no admin triggered path.
- `member.status` is a second source of truth about access, alongside the existence of the membership row. Every authorization path now has to consider both, and a future query that checks membership but forgets status is a real bug waiting to happen.
- One more migration on a Better Auth owned table, which means the CLI regeneration step has to be run in the right order or the schema drifts.
- Three new public, signed out pages, each of which is attack surface that has to be rate limited and must not leak whether an address or invitation exists.
- The storage footprint aggregates scan `file` per organization on every detail page view. Fine at current volume, and a candidate for caching only once measured.

**Neutral**:
- `requireOrgRole` currently throws a bare `Error("Forbidden")`, which surfaces as a 500 rather than a 403. This feature is the first heavy user of it from route handlers, so the throw needs to become a real 403 response.
- The Members section makes `/settings` the largest page in the app, which will probably force the profile, password, and second factor sections into their own subsections sooner than planned.
- Cursor pagination on a roster of a dozen people is over engineering today, and is specified anyway so the endpoint never has to change shape later.

## Follow-up

- [ ] Revisit the role matrix once there are more than a handful of admins. The chosen "any admin may act on any owner" rule is the loosest option; the containment alternative (admins manage members, owner manages admins) is the intended upgrade path and needs only the guard layer changed.
- [ ] Decide whether a suspended person's published contact cards should stay live. This spec keeps them live, matching the removal rule, but a departing employee's public card is a business question, not a technical one.
- [ ] Add an admin visible activity view. Per user audit history was explicitly cut from this scope, yet `audit_event` is already being written, so the data exists and is currently unreadable outside the database.
- [ ] Fix `requireOrgRole` to produce a 403 response rather than a thrown `Error`, before the endpoints in this spec are built on it.
- [ ] Consider an owner transfer action. Ownership can currently only move by promoting a second owner, and nothing demotes the original except another owner acting on them.
- [ ] The Cloudflare Workers, Drizzle, and Better Auth community skills are still not installed (already noted in the umbrella's Follow up list). They would materially help the migration and session revocation steps here.

## Amendments

Recorded 2026-08-31, reconciling this spec with what actually shipped in Phase 5 (see `docs/PROGRESS.md`). Two changes were made by request that go beyond — and in the first case reverse — the Decision above. Neither changes the data model or the acceptance criteria; they extend the surface.

1. **Admin-triggered password help was added**, overriding "Password reset is self service only, with no admin triggered reset button" (Decision) and directly resolving the Consequences negative "No admin can help a person whose email access is broken." The member detail page (`/settings/users/[id]`) gained two owner/admin actions in `src/components/member-actions.tsx`, backed by `adminSetPassword` and `sendMemberResetLink` in `src/server/members.ts`:
   - **Set password** — an admin sets a new password directly (hashed via `hashPassword` from `better-auth/crypto`).
   - **Send reset link** — issues a Better Auth reset link; the link is also returned in the response so it works even while `RESEND_API_KEY` is unset in production.

   Both are audited like every other member mutation and gated to owner/admin (behind 2FA, per the Security model). This is an authenticated admin path — the enumeration and self-service protections on the public `/forgot-password` / `/reset-password` flow (AC-13) are unchanged. Trade-off: it hands any admin a direct credential-reset capability over any member, so it should be re-evaluated under the same containment review as Follow-up item 1 if the role matrix is ever tightened.

2. **Self-service profile name editing was added**, which this spec did not cover (it scoped self-service to password reset only). `src/components/profile-section.tsx` lets a signed-in user edit their own display name via Better Auth `updateUser`. No new endpoint or audit action; it uses Better Auth's own user-update path.
