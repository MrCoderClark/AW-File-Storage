# Verify: Org membership & domain-based provisioning · spec 0014 · 2026-09-04
_Steps derived from spec 0014 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## Code
- [ ] `npx vitest run test/provisioning.test.ts` → domain uniqueness + consumer-domain blocklist; `resolveOrgsForEmail` maps a domain to its org; accept-provision creates the account + all memberships in one batch → AC-1, AC-2, AC-3
- [ ] `npx vitest run test/graph.test.ts` → `getVerifiedDomains` parses `/domains` and keeps only `isVerified` (mock fetch) → AC-1
- [ ] `npx vitest run test/members.test.ts` → assign-existing-user inserts memberships, skips duplicates, no email → AC-4
- [ ] `npx vitest run test/isolation.test.ts` → org_domains scoped per org; a non-platform-owner path can't reach cross-org provisioning → AC-6, AC-7
- [ ] `npx opennextjs-cloudflare build` → bundles cleanly

## Migration
- [ ] Generated migration is **additive**: creates `org_domains` + `provision`, no `DROP`/rebuild of `organization` (cat the SQL — gotcha #9) → AC-7
- [ ] Apply: `npx wrangler d1 migrations apply aw-file-storage --local` then `--remote`

## Manual
- [ ] **Domains (AC-1):** an O365-configured org → Save & test (or Refresh domains) → its verified Microsoft domains appear in `org_domains`; a consumer domain (gmail.com) is never claimable; the same domain can't be added to two orgs.
- [ ] **Provision + confirm (AC-2, AC-3):** as the platform owner, provision `someone@<verified-domain>` → the org is **pre-selected** → add a second org + set roles → confirm → the person gets one email, accepts, sets a password, and lands in both orgs (switcher shows them).
- [ ] **Assign existing (AC-4):** provision an already-existing account into another org → membership added immediately, no email; a duplicate is skipped.
- [ ] **CSV (AC-5):** upload `email,role[,org]` → preview resolves domains and flags unresolved/duplicate rows → confirm → invitations created.
- [ ] **Gating (AC-6):** a non-platform-owner (org admin) sees no Provisioning surface and is refused on the API; org-admin per-org invitations still work unchanged.

## Acceptance-criteria coverage
- AC-1 verified domains (O365 + manual, unique, consumer-blocked) · AC-2 pre-select + confirm/override · AC-3 multi-org account+memberships atomic on accept · AC-4 assign existing directly · AC-5 CSV preview + bulk · AC-6 platform-owner-only · AC-7 additive migration + isolation
