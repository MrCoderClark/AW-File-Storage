# Verify: SCIM 2.0 provisioning · spec 0015 · 2026-09-04
_Steps derived from spec 0015 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## Code
- [ ] `npx vitest run test/scim.test.ts` → token hash/verify + one-org resolution; POST /Users onboards account + `member` + **queues** a delayed email (nothing sent now); PATCH active:false suspends + revokes sessions; a token can't touch another org; malformed → clean 4xx → AC-1..AC-5
- [ ] `npx vitest run test/pending-email.test.ts` → flush sends only due, unsent rows, once each → AC-6
- [ ] `npx opennextjs-cloudflare build` → bundles cleanly

## Config
- [ ] Optional `SCIM_WELCOME_DELAY_MIN` (default 5). Reuses `CRON_SECRET`, `RESEND_API_KEY`.

## Migration
- [ ] Generated migration is **additive**: creates `scim_token` + `pending_email`, no `DROP`/rebuild of `organization` (cat the SQL — gotcha #9) → AC-6
- [ ] Apply: `npx wrangler d1 migrations apply aw-file-storage --local` then `--remote`

## Cron worker
- [ ] Add `*/5 * * * *` trigger to `cron/wrangler.jsonc` + branch in `cron/src/index.ts` (`event.cron`) to call `/api/cron/flush-emails`; **redeploy the cron worker** (`npx wrangler deploy --config cron/wrangler.jsonc` — separate from `npm run deploy`).

## Manual (per customer, prod)
- [ ] **Token (AC-1):** as platform owner, generate an org's SCIM token → base URL + secret shown once; rotate invalidates the old.
- [ ] **Entra setup:** Enterprise App → Provisioning → Tenant URL `https://www.awvcard.com/api/scim/v2` + Secret Token → **Test Connection** passes.
- [ ] **Onboard (AC-2):** assign a user in Entra → account + `member` membership appear here; the set-password email arrives **~5 min later** (mailbox ready).
- [ ] **Offboard (AC-3):** unassign the user in Entra → membership **suspended**, their sessions revoked, they lose access.
- [ ] **Isolation (AC-4):** a second org's token sees only its own users; it cannot read/modify org A's.
- [ ] **Hardening (AC-5):** SCIM works with no Origin header (bearer only); a bad body returns a SCIM 4xx; writes show in the audit log (actor "scim").

## Acceptance-criteria coverage
- AC-1 per-org hashed token · AC-2 create → member + delayed email · AC-3 update/suspend/remove (sessions revoked) · AC-4 one-org isolation · AC-5 bearer-auth, CSRF-exempt, audited, no leak · AC-6 additive migration + cron flush
