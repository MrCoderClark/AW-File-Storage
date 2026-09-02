# Verify: public card landing + analytics · spec 0008 · updated 2026-09-01
_Steps derived from spec 0008 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## Commands
- [ ] `npx wrangler d1 migrations apply aw-file-storage --local` → `card_stat_daily` created locally → AC-3, AC-11
- [ ] `npx wrangler d1 migrations apply aw-file-storage --remote` → same table live in prod → AC-3, AC-11
- [ ] Inspect `migrations/0010_ordinary_emma_frost.sql` → only `CREATE TABLE` / `CREATE INDEX`, no `DROP TABLE` → AC-11
- [ ] `npx vitest run test/card-stats.test.ts` → 11 pass (UPSERT/concurrency, bot filter, slug resolve, role scope) → AC-3, AC-4, AC-6, AC-7, AC-8
- [ ] `npx opennextjs-cloudflare build` → bundles cleanly (new `/c/[slug]` route + stats route) → AC-1, AC-2

## UI / manual (before the domain cutover — serve on www first)
- [ ] Visit `https://www.awvcard.com/c/<slug>.vcf` for a published card → downloads the identical vCard bytes, `Content-Type: text/vcard` → AC-1
- [ ] Visit `https://www.awvcard.com/c/<slug>` → styled landing page: name, title/org, tap-to-call phones, email, address+map link, socials, "Add to contacts", QR → AC-2
- [ ] Load the landing, then check the Files row for that card → view count went up by 1 → AC-3
- [ ] Visit `.../c/<slug>?src=qr` → the row's scan count went up (not the plain view) → AC-3
- [ ] Download the `.vcf` → the row's download count went up → AC-3
- [ ] `curl -A "Slackbot-LinkExpanding 1.0" https://www.awvcard.com/c/<slug>` → 200 but no count change → AC-4
- [ ] Visit `.../c/does-not-exist` and `.../c/does-not-exist.vcf` → both 404, no count → AC-6
- [ ] View page source of the landing → `<meta name="robots" content="noindex, nofollow">`; response carries `X-Robots-Tag: noindex, nofollow` → AC-10
- [ ] Scan the QR shown on the signature/print page → opens `/c/<slug>?src=qr` (the landing), counts a scan → AC-9
- [ ] Files page: each published card row shows views/scans/downloads; private/non-vCard rows show a dash → AC-7
- [ ] Dashboard: "Card Engagement" panel shows totals + 30-day trend and a "Top Cards" list → AC-8
- [ ] As a member (non-owner/admin): Dashboard engagement + `/api/cards/<id>/stats` show only your own cards; requesting another member's card stats returns 403 → AC-7, AC-8

## Cutover (operational, reversible — do last, after the www checks pass)
- [ ] R2 dashboard → `aw-files-public` → remove the `contacts.awvcard.com` custom domain
- [ ] Uncomment the `contacts.awvcard.com` route in `wrangler.jsonc`, then `npm run deploy`
- [ ] Confirm `https://contacts.awvcard.com/c/<slug>.vcf` is byte-identical and `.../c/<slug>` renders → AC-1, AC-2
- [ ] Rollback if needed: re-comment the route + deploy, re-add the R2 custom domain

## Acceptance-criteria coverage
- AC-1 (.vcf identical) … .vcf command + cutover confirm
- AC-2 (landing page) … landing manual + build
- AC-3 (view/scan/download counts, per day) … count manual + vitest UPSERT
- AC-4 (bot filter) … curl Slackbot + vitest
- AC-5 (fire-and-forget) … covered in code (waitUntil + swallowed errors); no crash under D1 failure
- AC-6 (404 no count) … not-found manual + vitest resolveCardBySlug
- AC-7 (Files rows + per-card trend) … Files manual + stats endpoint + vitest cardStatDetail
- AC-8 (Dashboard, role scoped) … Dashboard manual + vitest orgEngagement scope
- AC-9 (new QR → landing ?src=qr) … QR scan manual
- AC-10 (noindex preserved) … source + header check
- AC-11 (additive migration) … SQL inspection + vitest (table applies)
