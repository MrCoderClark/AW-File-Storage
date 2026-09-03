# Verify: Office 365 CustomAttribute1 sync · spec 0010 · updated 2026-09-02
_Steps derived from spec 0010 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## Setup (before it can do anything)
- [ ] Apply migrations 0012 (five `o365_*` columns on `file`) and 0013 (`o365_sync_enabled` on `app_settings`): `wrangler d1 migrations apply aw-file-storage --local` and `--remote`
- [ ] Secrets set (prod: `wrangler secret put`; local: `.dev.vars`): `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET` (credentials gate the feature)
- [ ] Enable: **Settings → Office 365 → toggle on** (owner/admin). No secret/redeploy needed; the toggle is stored in the DB. It stays disabled while the credentials are missing.
- [ ] Redeploy the **cron** worker so the nightly reconcile fires (it calls `/api/cron/o365-sync`). **This is a SEPARATE deploy — `npm run deploy` does NOT touch it:**
  ```bash
  npx wrangler deploy --config cron/wrangler.jsonc
  ```
  Verify in the Cloudflare dashboard that `aw-file-storage-cron`'s active version is dated *after* this change — otherwise the nightly run silently does cleanup-only. (This exact step was missed once: the reconcile ran cleanup-only from 2026-09-02 until the redeploy on 2026-09-03.)

## Commands
- [ ] `npx vitest run test/o365-sync.test.ts` → 6 pass (idempotent, clear, no_match/ambiguous, disabled no-op, error) → AC-2, AC-3, AC-5, AC-7
- [ ] `npx opennextjs-cloudflare build` → bundles cleanly

## Functional (with sync ON, a real Entra app + mailbox)
- [ ] Publish a card whose contact email = a real mailbox → that user's Exchange **CustomAttribute1** shows the card's `.vcf` URL; Files row shows **O365 ✓** → AC-1, AC-6
- [ ] Re-run / edit with no URL change → no second PATCH (check Graph isn't rewritten); still "synced" → AC-2
- [ ] Unpublish the card → CustomAttribute1 is cleared; the O365 badge goes away → AC-3
- [ ] Publish a card whose email matches **no** mailbox → Files row shows **O365: no match**, nothing written → AC-5
- [ ] Nightly reconcile: `curl -X POST -H "Authorization: Bearer <CRON_SECRET>" -H "Origin: https://www.awvcard.com" https://www.awvcard.com/api/cron/o365-sync` → `{"ok":true,"enabled":true,"processed":N}` → AC-4

## Off / safe (no Entra needed)
- [ ] With the Settings toggle off (or secrets absent): publish/edit/unpublish a card → works normally, no Graph call, `o365_sync_status` stays null, no errors → AC-7
- [ ] Graph credentials never appear in the client bundle or DB (only Worker secrets) → AC-8

## Acceptance-criteria coverage
- AC-1 write on publish · AC-2 idempotent · AC-3 clear on unpublish/delete · AC-4 nightly reconcile · AC-5 no/ambiguous match · AC-6 audit + Files status · AC-7 inert when off · AC-8 secrets server-side only
