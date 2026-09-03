# Verify: Organization isolation hardening + lifecycle · spec 0012 · 2026-09-03
_Steps derived from spec 0012 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## Code
- [ ] `npx vitest run test/isolation.test.ts` → passes, incl. the folded `settings` / `socialLinks` / `cardStats` helpers scoped per org (a foreign file id sees nothing) + `OrgScopeError` when no org → AC-2, AC-4 (data layer)
- [ ] `npx vitest run test/no-db-bypass.test.ts` → passes: the set of modules importing the raw `./db` client equals the documented allowlist (regression guard), and no allowlist entry is stale → AC-3
- [ ] `npx vitest run test/o365-sync.test.ts` → per-org toggle: org A on / org B off ⇒ only A's cards sync → AC-1
- [ ] `npx opennextjs-cloudflare build` → bundles cleanly

**Note on AC-4:** the cross-org 404 guarantee is enforced at the `orgDb` data layer (a foreign id → `.get()` undefined → the route returns 404 via `notFound()`; e.g. `cards/[id]/stats/route.ts`). Tests assert this at that layer. Full route-handler tests (mocking the Better Auth session + active org) are a follow-up — the enforcement point itself is the wrapper, which is covered.

## Migration
- [ ] Generated migration is **additive**: creates `org_settings`, does **NOT** `DROP TABLE organization` (cat the SQL — gotcha #9) → AC-8
- [ ] Backfill inserts one `org_settings` row per existing org, seeded from the current global `app_settings` values (O365 currently ON) so behaviour is unchanged
- [ ] Apply: `npx wrangler d1 migrations apply aw-file-storage --local` then `--remote`

## Config
- [ ] Set `PLATFORM_OWNER_EMAILS` (comma-separated, the app owner's verified email) — `wrangler.jsonc` var (non-secret) or `wrangler secret put` if preferred → AC-7

## Manual (two orgs)
- [ ] **Per-org settings (AC-1):** toggle O365 **on for org A, off for org B**; run the reconcile → only A's cards write CustomAttribute1. Toggle the card-login gate on org A only; confirm org B's card pages are unaffected.
- [ ] **Switcher (AC-5):** as a user in two orgs, switch from the header → every view (Files, stats, social links, settings) shows only the newly-active org; role re-reads from `member`.
- [ ] **Rename (AC-6):** owner renames the org; the header + Settings reflect it.
- [ ] **Delete (AC-6):** delete a throwaway org → its files/versions/uploads/audit/social-links/card-stats/settings rows are gone, its `files/${orgId}/…` R2 objects are swept, an audit row records it, and its public cards 404.
- [ ] **Create gate (AC-7):** the platform owner sees + uses "Create organization"; a normal org owner has no button and a direct API attempt is refused.
- [ ] **Cross-org (AC-4):** signed into org A, hit an org B file/card/member id directly → 404, not 403, not the row.

## Hygiene
- [ ] No module bypasses `orgDb()` for a tenant table (enforced by `no-db-bypass.test.ts`).
- [ ] `public_slug` remains globally unique on the shared public domain — documented as a deliberate shared-namespace choice, not a regression.

## Acceptance-criteria coverage
- AC-1 per-org settings · AC-2 wrapper covers all tenant tables · AC-3 import guard · AC-4 cross-org 404 · AC-5 switch + role re-read · AC-6 rename/delete + R2 sweep + audit · AC-7 platform-owner-only create · AC-8 additive migration + backfill
