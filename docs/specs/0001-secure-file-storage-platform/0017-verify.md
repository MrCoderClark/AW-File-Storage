# 0017 — Verification: Office 365 offboarding card removal

Companion to [0017-o365-offboarding-card-removal.md](0017-o365-offboarding-card-removal.md).
Automated tests run in the Workers pool (`npx vitest run`) with a fake Graph client;
the manual pass proves it against a real tenant.

## Automated tests (`test/o365-provision.test.ts`)

Same seed as spec 0016 (org-a connected, `aw.com` in `org_domains`), plus the
`o365RemoveOnOffboardEnabled` toggle flipped on per test. "Offboarded" fixtures are
disabled + unlicensed but still present in the directory.

- **Retract a manual card (AC-1/3/4)** — a disabled+unlicensed user on the O365 domain
  whose **manual** card was previously synced → the card is unpublished, `offboarded_at`
  is stamped, and `patchUserExtensionAttribute1(user, null)` clears CustomAttribute1.
- **Toggle gate (AC-1)** — with `o365RemoveOnOffboardEnabled` **off** (auto-card still
  on), the same offboarded user's card is **left published**.
- **Disabled-but-licensed (AC-2)** — a user who is disabled but **still licensed** (a
  suspension, not a departure) is **not** offboarded; the card stays published.
- **Absent user (AC-2)** — a user **missing** from the directory listing is **never**
  treated as offboarded (guards against a Graph glitch); the card stays published.
- **Non-O365 domain (AC-3)** — a card whose email is on a domain **not** in the org's
  `org_domains` is never touched, even for a disabled+unlicensed user.
- **Purge (AC-5)** — `purgeOffboardedCards` soft-deletes a card whose `offboarded_at`
  is **31 days** old and still private, **spares** one at 10 days, and **spares** a
  re-published (public) one even at 31 days.

## Migration check (AC-6)

The generated migration must be **`ADD COLUMN` only** —
`org_settings.o365_remove_on_offboard_enabled` (default 0) and `file.offboarded_at`
(nullable) — with no table rebuild (gotcha #9). Apply `--local`, run the suite, then
`--remote`.

## Build / deploy

`npx opennextjs-cloudflare build` bundles the new `/api/cron/o365-purge` route. The
**nightly** `0 3 * * *` cron now also calls it — **redeploy the cron worker**
(`npx wrangler deploy --config cron/wrangler.jsonc`). Offboard *detection* runs in the
existing weekday provision sweep (`0 13 * * 1-5`) + the "Check for new users now" button.

## Manual (one real tenant)

1. In a connected org, enable **"Remove cards when an Office 365 user is offboarded"**;
   confirm the warning copy and that it's disabled until credentials are connected.
2. Take a staff member who has a **published card** on your O365 domain, and offboard
   them the real way: **convert the mailbox to shared, remove the license** (which
   disables the account).
3. Click **"Check for offboarded users now"** (in the offboard panel; "Check for new
   users now" runs the same sweep too). Confirm: the card is **unpublished** (public
   page + `.vcf` stop resolving) and their **CustomAttribute1 is cleared** — the exact
   case that previously persisted.
4. Confirm a card for an **enabled** or **still-licensed** user is untouched, and a card
   on a **non-O365 domain** is untouched.
5. Grace window: set a test card's `offboarded_at` to 31+ days ago and run the purge
   (`POST /api/cron/o365-purge`, or wait for the nightly) — confirm it is soft-deleted;
   confirm a re-published card is spared.

## Safety sign-off

Because this deletes data, confirm before enabling for a real org: (a) removal only
fires on a **positive** disabled+unlicensed signal, never on directory absence; (b) only
cards on the org's **own** verified O365 domain are ever auto-retracted; (c) retraction
is reversible for **30 days** before the permanent purge.
