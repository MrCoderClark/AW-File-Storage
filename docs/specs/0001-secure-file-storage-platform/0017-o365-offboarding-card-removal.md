# 0017. Office 365 offboarding — remove cards for departed users

**Date**: 2026-09-07

## Summary

Spec 0016 auto-*creates* a contact card when a licensed Office 365 user appears. This
spec closes the other end of the lifecycle: when a user is **offboarded** — the
common pattern is converting their mailbox to **shared**, **removing their license**,
and **disabling** the account — the app should **retract their public contact card and
clear their CustomAttribute1**, then **permanently delete the card after a 30-day grace
period**. Crucially this covers **manually-created cards too**, not just
auto-provisioned ones — but only for people on the org's own O365 verified domain, so
the automation can never touch a card for an outside contact. It is a **per-org,
opt-in** behavior (off by default), gated by its own toggle and driven by a
**positive** disabled+unlicensed signal so a transient directory glitch can't wipe real
cards.

## Context

Today (spec 0016) `provisionCardsForOrg` has an **offboard pass**, but it only
unpublishes cards it **created** (`source='o365_auto'`) and triggers on `!inScope`
(disabled *or* unlicensed *or* absent). Two gaps surfaced in production:
1. A departed employee usually has a **manual** card (one of the pre-existing set), so
   nothing happens to it — and the nightly reconcile (spec 0010) *keeps re-writing*
   their CustomAttribute1, because a **shared mailbox still matches their email**.
2. Removal was immediate unpublish only, with no delete and no grace period.

The pieces to build on all exist: `org_domains` (the domain guard, spec 0014),
`listDirectoryUsers` with `accountEnabled`/`licensed` (spec 0016), `autoUnpublishVcard`
+ `syncCardToO365` (unpublish + clear), and the nightly cron.

## Requirements

**User stories**:
- As an org admin, when a staff member leaves (mailbox → shared, license removed,
  account disabled), I want their public contact card retracted and their
  CustomAttribute1 cleared automatically, so a departed person isn't still published.
- As an org admin, I want this to cover **manually-created** cards for my own staff too
  — but only people on my O365 domain, never outside contacts.
- As a cautious admin, I want a **grace period** — retract now, delete permanently only
  after 30 days — and this whole behavior **off until I opt in**, because it deletes
  data.

**Acceptance criteria**:
- **AC-1 (opt-in)**: A new per-org toggle **"Remove cards when an O365 user is
  offboarded"** (`org_settings.o365RemoveOnOffboardEnabled`, default **false**),
  owner/admin, in Settings → Office 365. Off by default; only effective with connected
  credentials + `o365SyncEnabled`. Independent of the auto-create toggle (an org may
  create-only, remove-only, both, or neither).
- **AC-2 (trigger — positive signal)**: A user is "offboarded" when they are **present
  in the directory** and **`accountEnabled=false`** and **unlicensed**. A user merely
  **absent** from a directory listing is **never** treated as offboarded (guards against
  a Graph paging/error wiping cards). A disabled-but-still-licensed account (e.g. a
  suspension) is **not** offboarded.
- **AC-3 (targets, domain-guarded)**: For each offboarded user, every **live published
  vCard** in the org — **manual or `o365_auto`** — whose `contactEmail` matches the
  user's mail **and** whose domain is one of the org's **verified O365 domains**
  (`org_domains`) is retracted. Cards on any other domain are never touched.
- **AC-4 (retract now)**: Retraction **unpublishes** the card (removes the public page +
  `.vcf`, keeps the private copy), **clears CustomAttribute1**, stamps
  `file.offboarded_at = now`, and audits `card.offboarded`. Idempotent.
- **AC-5 (delete after 30 days)**: A nightly purge **soft-deletes** any card whose
  `offboarded_at` is older than **30 days** and is still unpublished (a re-published card
  is spared — re-publishing clears `offboarded_at`). Audited `card.offboard_purged`.
  Applies uniformly to manual and auto cards.
- **AC-6 (isolation + safety)**: Per-org, using the org's own creds/domains; every
  action audited (system actor). The offboard pass only runs when the toggle is on. Grace
  window is reversible: an admin can re-publish within 30 days. Migrations additive
  (`ADD COLUMN`; no rebuild, gotcha #9).

## Decision

**Chosen approach**: extend `o365-provision.ts` so its offboard pass, **gated by the new
toggle**, retracts *any* domain-matched card (manual or auto) for a **disabled +
unlicensed** user, stamping `offboarded_at`; a **nightly purge** deletes cards past the
30-day grace window. Retraction reuses `autoUnpublishVcard` + `syncCardToO365`.

**Rejected**: immediate delete (no grace); touching cards on non-O365 domains (would
catch outside contacts); trusting directory *absence* as offboarding (glitch-prone);
disabled-*or*-unlicensed (would retract a temporary suspension that keeps its license).

## Feature design

**Data model** — additive columns (no rebuild, gotcha #9):

| Table | Change | Notes |
|---|---|---|
| `org_settings` | `+ o365_remove_on_offboard_enabled` boolean, default `false` | The opt-in (AC-1). |
| `file` | `+ offboarded_at` timestamp (nullable) | Set when a card is retracted by offboarding; drives the 30-day purge (AC-4/5). Cleared on re-publish/edit. |

**Offboard pass** (`o365-provision.ts`, rework the existing one): when
`o365RemoveOnOffboardEnabled` is on, build the set of **offboarded emails** =
`{ u.mail | u present, !u.accountEnabled, !u.licensed, u.mail }`. For each live
published vCard in the org whose `contactEmail` ∈ offboarded emails **and** whose domain
∈ `org_domains`: `autoUnpublishVcard` + `syncCardToO365` (clears the attribute) + set
`offboarded_at = now`, audit `card.offboarded`. The create pass (spec 0016) is unchanged
and independently gated by `o365AutoCardEnabled`; the sweep fetches the directory when
**either** toggle is on, and no longer early-returns unless **both** are off.

**Nightly purge** (`purgeOffboardedCards`, called from the `0 3 * * *` cron): soft-delete
cards where `offboarded_at < now − 30d`, `visibility='private'`, `deleted_at is null`.
Reuses the soft-delete + R2 cleanup + usage-decrement path (a system variant of
`deleteFile`, actor null). Audited `card.offboard_purged`.

**Re-publish clears the clock**: publishing/editing a card sets `offboarded_at = null`,
so an admin restoring a card within the window removes it from the purge.

**UI** (`o365-settings-section.tsx`): a third toggle under the auto-create toggle —
**"Remove cards when an O365 user is offboarded"** — owner/admin, off by default,
disabled until credentials are connected, with a warning: *"When a user is disabled and
unlicensed in your tenant, their published contact card (including manually-created
cards on your O365 domain) is unpublished and their CustomAttribute1 cleared, then
deleted after 30 days."* Backed by the existing `PUT /api/settings/o365`.

**Key invariants**:
- Off by default; per-org; positive disabled+unlicensed signal only; never on absence.
- Only cards on the org's **own O365 domain** are ever auto-retracted.
- Retract is reversible for 30 days; delete is the only irreversible step, and only
  after the grace window.
- Additive migrations; every action audited (system actor).

## Verification

See [0017-verify.md](0017-verify.md). Unit tests: toggle gate; a disabled+unlicensed
user's **manual** card on the O365 domain is retracted (unpublished + attribute cleared
+ `offboarded_at` set); a **disabled-but-licensed** user is left alone; an **absent**
user is left alone; a card on a **non-O365 domain** is never touched; the purge deletes
only cards past 30 days still unpublished and spares a re-published one; per-org
isolation. Manual: disable + unlicense a test user, confirm retract + cleared attribute,
and (with a back-dated `offboarded_at`) confirm the purge deletes it.

## Out of scope (later)

Configurable grace period; a "restore" button surfaced in the UI (re-publish already
works); notifying an admin of pending purges; handling a user renamed/re-mailed mid-window.
