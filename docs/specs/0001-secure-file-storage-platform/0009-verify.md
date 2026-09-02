# Verify: host-based card page access · spec 0009 · updated 2026-09-02
_Steps derived from spec 0009 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## Commands
- [ ] `npx vitest run` → 103 pass (no regression) → AC-1..AC-7
- [ ] `npx opennextjs-cloudflare build` → bundles cleanly (route + getSession) → all
- [ ] `grep -rn "preview" src/app/c src/server/uploads.ts` → only comments, no `?preview=1` flag → AC-6

## UI / manual (after deploy)
Public host stays open:
- [ ] `curl -s -o /dev/null -w "%{http_code} %{content_type}" https://contacts.awvcard.com/c/<slug>.vcf` → 200 `text/vcard` (no login) → AC-1
- [ ] `https://contacts.awvcard.com/c/<slug>` in a browser (no session) → landing renders → AC-1
- [ ] load `contacts…/c/<slug>` → Dashboard view count +1; `?src=qr` → scan +1; `.vcf` → download +1 → AC-3
- [ ] `https://contacts.awvcard.com/c/does-not-exist` → 404 → AC-1

App host gated + never counts:
- [ ] logged OUT, `curl -sI https://www.awvcard.com/c/<slug>` → `302` with `location: …/sign-in` → AC-2
- [ ] logged IN, open `https://www.awvcard.com/c/<slug>` → landing renders, and the Dashboard counts do NOT move → AC-3, AC-5
- [ ] Files page → click a published card's name → opens `www…/c/<slug>` (you're logged in), no count → AC-5

Unaffected flows:
- [ ] a QR code / email signature (targets `contacts`) still resolves and a scan counts → AC-4
- [ ] the Office 365 `.vcf` link (`contacts…/c/<slug>.vcf`) still downloads → AC-1

## Acceptance-criteria coverage
- AC-1 (contacts public) … public cur/browser + 404 checks
- AC-2 (www requires login) … logged-out 302 check
- AC-3 (count only public host) … public counts move, www counts don't
- AC-4 (QR/O365 unaffected) … scan + .vcf checks
- AC-5 (Files name link, no count) … in-app preview check
- AC-6 (no ?preview) … grep + build
