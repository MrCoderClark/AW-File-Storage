# 0019. Office 365 hard-delete offboarding

**Date**: 2026-09-07

## Summary

Spec 0017 offboards a user who is **disabled + unlicensed** (the convert-to-shared-
mailbox flow) using a *positive, present-in-directory* signal. But when an admin
**completely deletes** a user from Office 365, that user **vanishes from the active
directory** — so 0017 never sees them, their card stays published, and worse, the
nightly reconcile (spec 0010) keeps trying to clear their `CustomAttribute1` and gets a
**404** (the user is gone), logging a recurring `o365.sync_failed`. This spec closes
that gap three ways: (1) **tolerate the 404** when clearing a deleted user's attribute,
so it stops erroring; (2) **detect soft-deleted users** from Entra's recycle bin
(`/directory/deletedItems`) — a positive "this user was deleted" signal; and (3) catch
**permanently-deleted (purged)** users — who are in *neither* the active directory *nor*
the recycle bin — with a **direct `GET /users/{id}` lookup** that only retracts on a
confirmed **404**. All three retract the card exactly like an offboarded user (unpublish
+ clear + 30-day purge), under the same opt-in toggle.

## Context

`syncCardToO365` (spec 0010) reconciles a live card: if no user matches the email it
clears the previously-written attribute via `patchUserExtensionAttribute1(prevUserId,
null)`. For a **deleted** user that PATCH returns 404 and throws → `sync_failed` every
run. Meanwhile the offboard pass (spec 0017, `o365-provision.ts`) only acts on users
that are *present + disabled + unlicensed*, deliberately **never on mere absence** (a
Graph paging/error glitch must not wipe cards). A hard-deleted user is absent, so it is
missed. Entra keeps soft-deleted users for ~30 days in
`/directory/deletedItems/microsoft.graph.user`, which is a **reliable positive signal**.

## Requirements

**User stories**:
- As an admin, when I **delete** a user from O365 (not just disable them), I want their
  card retracted like any other departure — not left published.
- As an operator, I don't want a deleted user to generate a **recurring sync error**
  forever.

**Acceptance criteria**:
- **AC-1 (404 tolerant)**: Clearing `CustomAttribute1` on a user that no longer exists
  (404) is a **no-op success**, not an error. This alone stops the recurring
  `o365.sync_failed` for a deleted user.
- **AC-2 (hard-delete detection)**: When `o365RemoveOnOffboardEnabled` is on, the
  offboard pass also reads **`/directory/deletedItems/microsoft.graph.user`** and treats
  those users as offboarded, matched to a card by the card's **stored Graph user id**
  (`file.o365UserId` — reliable even when a deleted user's email is mangled) or by email
  when the deleted record still carries one. The card is retracted + purged on the **same
  terms as spec 0017** (unpublish + clear + `offboarded_at` + 30-day delete), and only on
  the org's **own O365 domain**.
- **AC-3 (positive signal preserved)**: Detection is still **never** based on a user
  simply being absent from the active-directory listing — only a confirmed deletion (or
  disabled+unlicensed) triggers a retraction.
- **AC-4 (graceful degradation)**: If the recycle-bin read is unavailable (e.g. the
  Entra app lacks `Directory.Read.All`/`User.Read.All`), the run **skips** hard-delete
  detection without erroring; the disable path and the 404-tolerant clear still work.
- **AC-5 (permanent deletion → delete, not grace)**: For a card whose stored
  `o365UserId` is in **neither** the active directory **nor** the recycle bin, a
  **direct `GET /users/{id}`** confirms the deletion: a **404** means the account is
  **permanently gone and unrecoverable**, so the card is **deleted immediately** (no
  30-day grace — there is no account it could ever be re-associated with). A 200 (the
  user still exists — a listing glitch) or any error **never** acts. Distinguishing a
  *permanent* delete from a *soft* delete requires the recycle-bin read to have
  **succeeded** (so we know the id truly isn't in it): if that read **failed** (no
  permission), we cannot tell them apart, so we fall back to the safe **retract + 30-day
  grace** rather than an irreversible delete. Soft-deleted users (found in the recycle
  bin, AC-2) always get the grace, since they are restorable for ~30 days.

## Decision

Extend `graph.ts` and the spec-0017 offboard pass; **no schema change** (reuses
`file.offboarded_at` + the 30-day purge).

- `patchUserExtensionAttribute1` returns on **404** instead of throwing (AC-1).
- New `listDeletedUsers(creds)` → paged `/directory/deletedItems/microsoft.graph.user`
  (id + mail).
- New `graphUserExists(creds, id)` → `GET /users/{id}` (200 → true, 404 → false, else
  throw) — the confirmed-deletion check for AC-5.
- The offboard pass adds deleted users to its target set — by **id** (from
  `file.o365UserId`) and by email when present — inside a `try/catch` so a missing
  permission degrades to a no-op (AC-4); and for a card whose id is in neither the active
  nor deleted set, it calls `graphUserExists` and retracts only on a 404 (AC-5).
  Retraction reuses `autoUnpublishVcard({offboarded})` + `syncCardToO365` (which now
  clears without erroring even though the user is gone).

**Rejected**: treating *absence* from the active directory as a deletion (glitch-prone —
the whole reason 0017 uses a positive signal); a separate toggle for hard-deletes (it is
the same offboarding intent, so it shares `o365RemoveOnOffboardEnabled`).

## Notes / operational

- The Entra app may need **`Directory.Read.All`** (or `User.Read.All`) consented to read
  the recycle bin; without it, hard-delete detection silently no-ops (AC-4) but the 404
  fix still stops the error. Document alongside the spec-0013 connection guide.
- Entra retains deleted users ~**30 days**; a user deleted longer ago won't be detected,
  but their reconcile no longer errors (AC-1) and their card can be removed by hand.

## Verification

See [0019-verify.md](0019-verify.md). Unit tests (`test/o365-provision.test.ts`): a
hard-deleted user (present only in `listDeletedUsers`, matched by stored id with a null
mail) → card retracted + `offboarded_at` set + attribute cleared; a `listDeletedUsers`
failure → no crash, no retraction (disable path intact). Manual: delete a test user in
O365, run "Check for offboarded users now", confirm the card is retracted and no
`sync_failed` recurs.
