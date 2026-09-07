# 0019 — Verification: O365 hard-delete offboarding

Companion to [0019-o365-hard-delete-offboarding.md](0019-o365-hard-delete-offboarding.md).
No migration — reuses `file.offboarded_at` + the spec-0017 purge.

## Automated tests (`test/o365-provision.test.ts`)

- **Hard-delete retract (AC-2/3)** — a user absent from the active directory but present
  in `listDeletedUsers` (mail `null`, so only the stored `file.o365UserId` matches) → the
  card is unpublished, `offboarded_at` is stamped, and
  `patchUserExtensionAttribute1(id, null)` is called. Proves id-matching works even when
  the deleted record has no usable email.
- **Graceful degradation (AC-4)** — `listDeletedUsers` throws (e.g. 403 missing
  permission) → `provisionCardsForOrg` does **not** throw, retracts nothing, and leaves
  the card published. The disable path is unaffected.
- **Permanent-delete retract (AC-5)** — a card whose `o365UserId` is in neither the
  active directory nor the recycle bin, with `graphUserExists` → `false` (404) → the
  card is retracted + attribute cleared.
- **Glitch guard (AC-3/5)** — same setup but `graphUserExists` → `true` (the user still
  exists on a direct lookup — a transient listing gap) → **nothing** is retracted.
- **Still no absence-based action (AC-3)** — the existing "absent user is never
  offboarded" test still holds with `listDeletedUsers` returning `[]`.

The 404 tolerance (AC-1) is exercised implicitly: after retraction, `syncCardToO365`
clears the (now-gone) user's attribute; in production that PATCH 404s and is treated as a
no-op instead of `sync_failed`.

## Manual

1. Ensure the Entra app can read the recycle bin — consent **`Directory.Read.All`** (or
   `User.Read.All`) if hard-delete detection doesn't fire (without it, only AC-1 applies).
2. With **"Remove cards when an O365 user is offboarded"** on, take a test user who has a
   published card and **delete** them from O365 (not just disable).
3. Click **"Check for offboarded users now"**. Confirm: the card is **unpublished**, the
   attribute clear does **not** produce an `o365.sync_failed` in Activity logs, and
   `file.offboarded_at` is set (it will hard-delete after 30 days).
4. Confirm a user deleted more than ~30 days ago no longer produces a recurring sync
   error even though it isn't auto-detected (AC-1).
