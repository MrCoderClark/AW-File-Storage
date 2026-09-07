# 0018 — Verification: Activity logs

Companion to [0018-activity-logs.md](0018-activity-logs.md). No migration — a read over
existing `audit_event` data.

## Automated tests (`test/log-format.test.ts`)

- **Categorisation (AC-3)** — `card.auto_created`/`member.added` → `onboard`;
  `card.offboarded`/`member.removed` → `offboard`; `vcard.published` → `vcard`;
  `o365.sync_failed` → `error`; an unknown action → `other`.
- **Status (AC-3)** — only `*_failed` actions are `failed`; everything else `success`.
- **`actionsForCategory` (AC-2)** — returns a category's concrete actions (drives the
  server-side filter).
- **`logDetail` (AC-3)** — pulls `name` > `email` > `slug` > `role` from metadata,
  tolerates malformed JSON (returns ""), and **does not** return a URL.

## Manual

1. As any **member** (not just admin), open the **Activity logs** link in the side rail
   (where "Recent Activity" used to be) → it loads `/activity` in the content area.
2. **Header stats** show logs today, O365 success rate, active vCards.
3. **Filters:** switch the range (24h/7d/30d/all); click the category chips (All / VCard
   Gen / Onboarding / Offboarding / Sync errors); type in search — the list updates and
   "Load more" pages through older rows.
4. **Readable rows (AC-3):** an `o365.synced` row reads *"Office 365 attribute synced —
   <contact name>"* (not a `.vcf` URL); an offboarding row reads *"Card retracted (user
   offboarded) — <name>"*; timestamps are New York Eastern `MM-DD-YYYY h:mmAM/PM`.
   Never a raw UUID. **View details** expands the full metadata JSON (URL included).
5. **Responsive (AC-6):** narrow the viewport below ~768px — the table becomes stacked
   cards; nothing clips and the page body does not scroll horizontally. Widen again →
   the table returns.
6. **Isolation:** a second org's members see only their own org's events.
