# 0029. Admin controls for the bulk import rate limit

**Date**: 2026-09-10
**Status**: Accepted

## Summary

Bulk contact card import (spec 0028) caps each user at a fixed number of imports per hour, set
only by an environment value (`IMPORT_RATE_PER_HOUR`, default 5). When a real user hits that cap
there is no way for an admin to help them short of a redeploy or hand written SQL. This spec adds
two owner and admin controls: a per organization "imports per hour" setting that overrides the
environment default, and a per user "reset import limit" action that lets a blocked user submit
again right away. The reset moves the counting window forward using an audit event, so it never
deletes the user's import history.

## Context

The spec 0028 rate limit is a single global environment value, counted from each user's
`card_import` rows in the last hour. It is the only guard against a member bulk publishing many
people's personal data, so it should stay, but a global constant is too blunt in practice: one
organization may legitimately onboard several teams in an afternoon, and one person may hit the cap
during normal work. Today the only remedies are editing an environment value and redeploying, or
deleting rows in the database by hand (which also destroys the audit trail). Both are operator only
and error prone.

Two forces shape the design. First, `member` is a Better Auth owned table, regenerated from its
schema, so we do not add columns to it. Second, the reset must not erase history: the import records
are the audit trail for a privileged, personal data action (spec 0028), so a reset has to change the
counting window, not remove rows.

## Requirements

**User stories**:
- As an owner or admin, I want to raise or lower the imports per hour cap for my organization, so
  that a busy onboarding day is not blocked by a global default meant for everyone.
- As an owner or admin, I want to clear one user's import limit on the spot, so that a person who hit
  the cap during normal work can keep going without waiting an hour or asking an operator.
- As an owner, I want these controls to respect the owner tier rule, so that an admin cannot act on
  an owner's account.
- As a compliance minded operator, I want every limit change and reset recorded, so that loosening
  the abuse guard is always attributable.

**Acceptance criteria**:
- **AC-1**: An owner or admin can set an "imports per hour" value for their organization (an integer
  from 1 to 100) in Settings, and it is saved and shown. Leaving it blank clears the override.
- **AC-2**: The bulk import rate limit (spec 0028 AC-9) uses the organization's configured value when
  one is set, otherwise the environment default (`IMPORT_RATE_PER_HOUR`, default 5).
- **AC-3**: An owner or admin can reset a specific user's import rate limit from the Members page, and
  that user can immediately submit an import again; their imports from before the reset no longer
  count toward the hourly cap.
- **AC-4**: A reset does not delete the user's `card_import` records or any import history; it only
  moves the counting window forward.
- **AC-5**: Both controls are owner and admin only; only an owner may reset an owner (the owner tier
  rule, spec 0021). A member receives 403.
- **AC-6**: Each control writes one audit event: `import.rate_limit_changed` (with the old and new
  value) when the organization limit changes, and `import.rate_reset` (naming the acting admin and
  the target user) on a reset. Both appear in Activity (spec 0018).
- **AC-7**: The organization limit is bounded: a value outside 1 to 100 is rejected (400), and a blank
  value clears the override so the environment default applies again.
- **AC-8**: Both the setting and the reset are scoped to the active organization through `orgDb`, so
  one organization's limit or reset never affects another.

## Options considered

The controls themselves (a per organization setting, a per user reset) were chosen with the engineer.
The one real design choice was where to store the per user reset, given `member` is off limits.

### Option 1: Reuse the audit trail as the reset marker (recommended)

A reset writes an `import.rate_reset` audit event naming the target user. The rate limit count then
counts a user's imports created after the most recent such event for them, so the event doubles as
the record of the action and the high water mark that resets the window.

**Pros**:
- No new table or migration for a single timestamp.
- The reset is inherently audited (the event is both the marker and the audit record).
- Matches the existing pattern: the spec 0027 AI draft limit already throttles from the audit trail.

**Cons**:
- Couples the reset semantics to the audit table; if audit rows ever gain a retention or pruning
  policy, a reset would silently lapse (audit is currently never pruned, and the events are cheap).
- The submit path does one extra small read (the user's latest reset event).

### Option 2: A dedicated `import_rate_reset` table

A small table keyed by `(org_id, user_id)` holding a `reset_at` timestamp, upserted on each reset.

**Pros**:
- One indexed read, cleanly separated from the audit trail; no coupling to audit retention.

**Cons**:
- A whole table and migration for one timestamp per user.
- The reset still needs its own audit event anyway, so this adds storage without removing the audit
  write.

## Decision

**Chosen option**: Option 1: store the per user reset as an `import.rate_reset` audit event and count
each user's imports since the later of one hour ago and their most recent reset event. The per
organization cap is a new nullable `org_settings.import_rate_per_hour` column that overrides the
environment default when set.

**Implementation skills**: `tailwindcss-v4` (`.claude/skills/tailwindcss-v4/`) · `frontend-design` (`.claude/skills/frontend-design/`) · `playwright` (`.claude/skills/playwright/`)

## Rationale

The `member` table being Better Auth owned rules out the obvious "put a column on the membership"
answer, so per user state has to live elsewhere. Between a dedicated table and the audit trail, the
audit trail wins on the two forces that matter here: a reset must be recorded anyway (it loosens a
privileged guard), and the codebase already treats the audit trail as a lightweight per user throttle
store (spec 0027). Making the reset event both the record and the window marker removes the need for a
second store. The one honest cost, coupling to audit retention, is noted as a follow up; today audit
rows are never pruned.

The per organization cap belongs in `org_settings` because that is where every other per org toggle
already lives (spec 0012), reached only through `orgDb().settings`, so it inherits the tenant scoping
for free. Keeping the environment value as the fallback means nothing changes for an organization that
never sets an override.

## Feature design

**Data model sketch**:
- `org_settings.import_rate_per_hour` (integer, nullable). Null means "no override, use the
  environment default". When set, it is constrained in application code to 1 to 100 (AC-7). Additive
  `ADD COLUMN` on the existing per org settings row; `org_settings` is a leaf table, so the migration
  is create only and cannot rebuild a parent (gotcha #9).
- No new table. A reset is an `import.rate_reset` row in the existing `audit_event` table:
  `action = "import.rate_reset"`, `target_type = "user"`, `target_id = <reset user id>`,
  `actor_user_id = <acting admin>`, scoped to the org. The most recent such row's `created_at` is the
  user's reset high water mark.

**Effective limit resolution** (used by the spec 0028 submit path):
- `limit = clamp(org_settings.import_rate_per_hour ?? env IMPORT_RATE_PER_HOUR ?? 5, 1, 100)`.
- `floorMs = max(now - 3600_000, latest import.rate_reset created_at for this user, or 0)`.
- The user is over the cap when their `card_import` count since `floorMs` is `>= limit`. This replaces
  the fixed `now - 1h` window in spec 0028's `countRecentByActor` call with `floorMs`.

**API surface**:
| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| Organization settings save (the existing owner/admin settings update, e.g. `/api/organization`) | PATCH | `importRatePerHour: int 1..100 \| null` | `ok` | owner or admin of the active org | 400 out of range, 403 |
| `/api/members/[id]/import-rate-reset` | POST | path `id` (the user to reset) | `ok` | owner or admin, owner tier | 403 not allowed, 404 unknown member |

**Key invariants**:
- The effective limit is always `org_settings.import_rate_per_hour` when set, else the environment
  default, and is always within 1 to 100.
- A reset never deletes a `card_import` row; it only advances the per user counting floor.
- Both writes go through `orgDb(orgId)` and are scoped to the active organization (AC-8).
- Every limit change and every reset writes exactly one audit event before returning success.

**Security model**: Changing the organization limit is owner or admin, the same tier that manages
other organization settings. Resetting a user is owner or admin and obeys the owner tier rule (spec
0021): an admin may reset a member or another admin, but only an owner may reset an owner. The acting
caller and target are resolved server side from the session and the active organization, never from
the request body. A member is denied (403). The feature loosens a personal data abuse guard, so both
actions are audited and attributable (AC-6).

**Configuration required**:
- `IMPORT_RATE_PER_HOUR`: unchanged from spec 0028; now the fallback default when an organization sets
  no override.

**Critical test scenarios** (each maps to an acceptance criterion):
- Happy path: an admin sets the organization limit to 20; a user can submit 20 imports in an hour
  where 5 was the old ceiling. Verifies **AC-1**, **AC-2**.
- Reset: a user at the cap is reset by an admin, immediately submits again, and their pre reset imports
  no longer count; their `card_import` rows are still present. Verifies **AC-3**, **AC-4**.
- Bounds: setting 0 or 101 is rejected with 400; clearing the field restores the environment default.
  Verifies **AC-7**.
- Authorization: a member gets 403 on both actions; an admin gets 403 trying to reset an owner; an
  owner can reset an owner. Verifies **AC-5**.
- Audit: a limit change writes `import.rate_limit_changed` (old and new) and a reset writes
  `import.rate_reset` (actor and target), both visible in Activity. Verifies **AC-6**.
- Tenancy: organization A's limit and resets have no effect on organization B. Verifies **AC-8**.

## Build plan

1. Migration: add `org_settings.import_rate_per_hour` (nullable integer). Inspect the generated SQL to
   confirm a plain `ADD COLUMN` with no `org_settings` rebuild (gotcha #9). Satisfies **AC-1** (storage),
   **AC-7**.
2. Effective limit and reset aware counting in the spec 0028 submit path (`createCardImport`): resolve
   the effective limit (organization value or environment default, clamped 1 to 100) and compute the
   counting floor as the later of one hour ago and the user's most recent `import.rate_reset` event;
   count imports since that floor. Add the `orgDb` helpers this needs (read the setting, read the
   latest reset time). Satisfies **AC-2**, **AC-3**, **AC-4**.
3. Per organization limit control: an `orgDb().settings` getter and setter, plus the Settings control
   (owner and admin) wired into the existing organization settings save, with 1 to 100 validation and
   a blank value clearing the override. Satisfies **AC-1**, **AC-7**.
4. Per user reset: `POST /api/members/[id]/import-rate-reset` (owner and admin, owner tier) that writes
   the `import.rate_reset` audit event, plus a "Reset import limit" action on the Members page row menu.
   Satisfies **AC-3**, **AC-5**.
5. Activity surfacing: format and label the two new actions (`import.rate_limit_changed`,
   `import.rate_reset`) in the Activity feed (spec 0018). Satisfies **AC-6**.
6. Tenancy and tests: unit (effective limit resolution, reset floor math), integration against real
   bindings (organization limit respected, reset unblocks a capped user, owner tier enforced, one
   organization does not affect another), and a verify pass. Satisfies **AC-5**, **AC-8**, and covers
   every acceptance criterion.

## Consequences

**Positive**:
- Owners and admins self serve both raising the cap for their organization and unblocking one person,
  with no redeploy and no hand written SQL.
- The reset preserves the import history and is itself audited, so loosening the guard stays
  attributable.
- Reuses the existing `org_settings` and audit trail patterns; one nullable column, no new table.

**Negative / tradeoffs**:
- Another per organization setting and a per user reset path to maintain.
- The submit path does one extra small read (the user's latest reset event) per import.
- The reset marker lives in the audit trail, so a future audit retention or pruning policy would need
  to exempt `import.rate_reset` events (noted in Follow-up).

**Neutral**:
- The environment default remains the floor when no override is set; nothing changes for an
  organization that never configures a value.

## Follow-up

- [ ] Show the effective limit and the last reset time on the member detail, so an admin can see the
      current state before acting.
- [ ] If the audit trail ever gains a retention or pruning policy, exempt `import.rate_reset` events or
      move the reset marker to a dedicated store (Option 2).
- [ ] Deferred by choice for 0029: a per user custom limit or "never rate limited" exemption, and admin
      control of the per import row cap (`MAX_IMPORT_ROWS`). Revisit if member run bulk publishing needs
      finer control.
