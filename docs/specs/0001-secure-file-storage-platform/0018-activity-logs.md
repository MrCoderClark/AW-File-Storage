# 0018. Activity logs

**Date**: 2026-09-07

## Summary

The app already writes an **audit row for every state-changing action** (spec 0002
AC-8) — publishes, edits, member changes, invitations, and all the O365 automation
(`card.auto_created`, `card.offboarded`, `o365.synced`, …). This spec surfaces that
trail as a **read-only Activity Logs page**: a professional, filterable, paginated
table of everything that has happened in the organization, reached from a link in the
side rail (replacing the old "Recent Activity" panel). It is **open to any signed-in
member** (read-only; there are no controls to gate), each event is decorated with a
human **category, status, actor, and a readable target name** (never a raw UUID), and
the layout is fully responsive (a table on wide screens, stacked cards on phones).

## Context

`audit_event` (spec 0002) holds `action`, `actor_user_id`, `target_type`,
`target_id`, `metadata_json`, `created_at`, indexed by `(org_id, created_at)`. Until
now it was surfaced only as a tiny "Recent Activity" list in the side rail
(`getRailData`) and per-member on the detail page. There was no way to see, filter, or
search the whole org's history. The `orgDb` scoped wrapper (spec 0002/0012) is the
sanctioned door to this org-scoped data.

## Requirements

**User stories**:
- As a member, I want to see everything that has happened in my organization —
  especially users being onboarded and offboarded — in one place.
- As a member, I want to filter by time range and event type and search, so I can find
  a specific event quickly.
- As a member on a phone, I want the log to stay readable, not clip off the screen.

**Acceptance criteria**:
- **AC-1 (access)**: The Activity Logs page and its `/api/logs` feed are open to any
  signed-in **member** of the org (owner/admin/member); it is **read-only** and exposes
  no mutating controls. It reads only the acting org's rows (org-scoped, spec 0002).
- **AC-2 (feed)**: `/api/logs` returns audit rows **newest first**, **keyset-paginated**
  (a `[created_at, id]` cursor, "Load more"), filtered by **date range**
  (24h/7d/30d/all), **category**, and a **search** over action/target/metadata/actor.
- **AC-3 (readable rows)**: Each row is decorated for display — an **event-type
  category** + label (VCard Generation, Onboarding, Offboarding, O365 Sync, Sync Error,
  User Management, File, System), a **status** (success, or failed for `*_failed`
  actions), the **actor's name** ("System" for automated actions), and a **human detail**
  resolved from the metadata (name/email/slug) or the **target's name** (a card's
  contact, a member's person) — **never a raw UUID**, and never a long `.vcf` URL.
- **AC-4 (header stats)**: The page shows **logs today**, **O365 success rate**, and
  **active vCards** for the org.
- **AC-5 (rail entry)**: The side rail's "Recent Activity" panel is **replaced** by an
  **Activity logs** link to `/activity`, rendering the page in the content area.
- **AC-6 (responsive)**: A table at `md` and up; **stacked cards below `md`** so nothing
  clips or requires horizontal scrolling on a phone. No new migration — this is a read
  over existing data.

## Decision

**Chosen approach**: a read-only page over `audit_event`, with the query in the `orgDb`
scoped wrapper and the presentation mapping in a pure, tested `lib/log-format.ts`.

- **Query** (`orgDb().audit.listPage` + `.stats`): filtered, keyset-paginated, joins
  `user` for the actor name, and resolves each `target_id` to a human name by batch
  lookup (`file.contact_name`, member→user, user).
- **Mapping** (`src/lib/log-format.ts`, pure/tested): `logCategory`,
  `logCategoryLabel`, `logActionPhrase`, `logStatus`, `logDetail`, `actionsForCategory`.
- **Route** `GET /api/logs` (member-gated) → decorated rows + stats + next cursor.
- **UI**: `/activity` page (`requireOrgRole("member")`) → `LogsView` (filter bar, header
  stats, responsive table/cards, "View details" expands the metadata). Rail link
  replaces Recent Activity.

**Rejected**: gating to admins (there is nothing sensitive to mutate and the org owner
asked to open it to members); a raw UUID / `.vcf` URL in the detail column (unreadable,
and the long URL token broke the table width); a live-tailing feed (paginated snapshot
is enough; the rail already gives an at-a-glance recent view was removed in favor of
this fuller page).

## Feature design

**No migration** — reads `audit_event` (and joins `user`/`file`/`member` for names).

**Timestamps** render in **New York Eastern** (`America/New_York`) as
`MM-DD-YYYY h:mmAM/PM`, DST-correct via `Intl`.

**Categories → actions** (the filter chips map a category to its concrete actions):
`vcard.published/edited` → *VCard Generation*; `card.auto_created` + `member.added/
joined/invited` → *Onboarding*; `card.offboarded/auto_unpublished/offboard_purged`,
`vcard.unpublished`, `member.removed/suspended` → *Offboarding*; `o365.synced/cleared`
→ *O365 Sync*; `o365.sync_failed` → *Sync Error*; other `member.*` → *User Management*;
`file.*` → *File*.

**Key invariants**:
- Read-only; org-scoped through `orgDb`; no new mutation surface.
- The detail is always human-readable — a resolved name, never a UUID or a raw URL (the
  URL stays available in the expandable metadata).
- Responsive: table (md+) / cards (below md); the page body never scrolls horizontally.

## Verification

See [0018-verify.md](0018-verify.md). Unit tests: `test/log-format.test.ts`
(categorisation, status, `actionsForCategory`, `logDetail` incl. bad JSON and no-URL).
Manual: open `/activity` as a member; filter by range/category, search; confirm
onboarding/offboarding events read with names (not UUIDs), Eastern timestamps, and that
the layout switches to cards below ~768px with no clipping.

## Out of scope (later)

CSV/JSON export of a filtered range; a per-user or per-target drill-down; retention /
archival of old audit rows; real-time streaming.
