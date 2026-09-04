# 0016 — Verification: auto-provision cards from the O365 directory

Companion to [0016-o365-directory-auto-cards.md](0016-o365-directory-auto-cards.md).
Every acceptance criterion has a check below. Automated tests run in the Workers pool
(`npx vitest run`) with a fake Graph client (no live tenant); the manual pass proves it
end-to-end against a real Microsoft tenant.

## Automated tests (`test/o365-provision.test.ts`, plus existing suites)

Seed: one org with connected (fake) creds, `o365SyncEnabled` + `o365AutoCardEnabled`
on, a verified domain in `org_domains`. A stub `listDirectoryUsers` returns a
controllable set of directory users; `patchUserExtensionAttribute1` and the R2 writes
are captured.

- **Field mapping (AC-4)** — a directory user maps to the expected `CardFields`
  (display/given/surname, title, mobile vs business phone precedence, single-line vs
  multi-line address, company); `buildVcard` output round-trips through `parseVcard`.
- **Create pass (AC-2/4/5/8)** — an enabled, licensed user with `mail` and **no
  existing card** → exactly one live published vCard is created with
  `source = 'o365_auto'` and `o365UserId` set, its public URL is written to
  CustomAttribute1, and `card.auto_created` is audited.
- **Mailbox-readiness skip (AC-2)** — a user with `mail` empty (mailbox not ready) →
  **no card**, no error; a later run once `mail` is populated creates it. Proves the
  "wait for the mailbox" behavior is detection, not a timer.
- **Licensed/enabled filter (AC-2)** — an unlicensed user and a disabled user are
  **skipped** in the create pass.
- **Org resolution (AC-3)** — a user whose email domain does not map to the swept org
  is **skipped** (never cross-filed); with two verified domains → the card lands in the
  domain's org.
- **Non-clobber / idempotent (AC-5)** — a user who already has a **manual** card → no
  duplicate, manual card untouched; running the sweep twice is a no-op (no second card,
  no redundant PATCH).
- **Offboard pass (AC-7/8)** — an `o365_auto` card whose user is now
  `accountEnabled: false` (or unlicensed, or `mail` gone) → the card is **unpublished**
  and CustomAttribute1 **cleared**, audited `card.auto_unpublished`. A **manual** card
  for a disabled user is **left published** (only auto cards are auto-unpublished).
- **Toggle + creds gate (AC-1)** — with `o365AutoCardEnabled` off, or creds absent, or
  `o365SyncEnabled` off, `provisionCardsForOrg` is a **no-op**.
- **Isolation (AC-9)** — a second org's users/cards are never touched by a sweep of the
  first org; each sweep uses its own creds. Extends `test/isolation.test.ts`.
- **Allowlist (spec 0002/0012)** — `test/no-db-bypass.test.ts` lists
  `src/server/o365-provision.ts` with a reason (cross-org system job).

## Migration check (AC-9)

Inspect the generated migration before applying: it must be **`ADD COLUMN` only** —
`org_settings.o365_auto_card_enabled` (default 0) and `file.source` (default
`'manual'`) — with **no `CREATE TABLE`…copy…`DROP`** rebuild of any existing table
(gotcha #9). Apply `--local`, run the suite, then `--remote`.

## Build

`npx opennextjs-cloudflare build` bundles the new route + server module. Redeploy the
**companion cron worker** so the new `*/10 * * * *` trigger registers
(`npx wrangler deploy --config cron/wrangler.jsonc`); confirm both `0 3 * * *` and
`*/10 * * * *` show under the worker's Triggers.

## Manual (one real tenant)

1. In an org with connected O365 credentials, enable **"Auto-create contact cards from
   Office 365 users"**; confirm the warning copy is shown and the toggle is disabled
   until credentials are connected.
2. Create a **licensed** test user in that Microsoft tenant.
3. Within ~10 minutes (a poll tick after the mailbox provisions), confirm: a published
   card exists in the app (Files, marked auto-created), its landing page + `.vcf`
   resolve, and the user's **CustomAttribute1** holds the public URL.
4. Confirm re-running "Sync all now" does **not** create a duplicate.
5. **Disable** (or unlicense) that user in Entra; within a sweep, confirm the card is
   **unpublished** and CustomAttribute1 is **cleared**.
6. Confirm a **manually** created card for a different person is unaffected by both
   passes.
7. Confirm a second org (its own tenant) sees none of the first org's users or cards.

## Privacy sign-off

Because this publishes staff PII to public URLs, confirm before enabling for a real
org: (a) the org has agreed to publish these contact cards, (b) the toggle warning is
accurate, (c) public pages carry `noindex` (spec 0008/0009), and (d) offboarding
(unpublish + clear) works, so leaving the company removes the public card.
