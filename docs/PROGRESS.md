# Progress & handoff — AW File Storage

Living status doc for session continuity. Read this + [AGENTS.md](../AGENTS.md) +
the specs in [docs/specs/](specs/0001-secure-file-storage-platform/index.md)
before continuing. Last updated: **2026-08-28**.

## TL;DR — where we are

**The app is BUILT and DEPLOYED to production, and the full product loop works.**
Drop a `.vcf` in the browser → it uploads directly to R2 → validates → publishes
→ resolves at a live public URL. Non-vCard files stay private with signed
download links. Auth, tenancy, uploads, and publishing are all done and verified.

- **Live app:** https://www.awvcard.com (custom domain; `awvcard.com` 301→www). Old `*.workers.dev` still resolves.
- **Owner account:** `jclark@americaworks.com` (prod). Local dev owner: `owner@americaworks.test`.
- **Public vCard URLs:** `https://contacts.awvcard.com/c/<slug>.vcf` (R2 bucket custom domain; `PUBLIC_FILE_DOMAIN`).
- **Branch:** `phase-5-user-management` (Phase 5 built, **not yet committed**; prod still runs Phase 4 code — Phase 5 is undeployed).
- **⚠️ Deploy/migration hazard:** a Drizzle table-rebuild on a Better Auth **parent** table cascade-wiped `member`/`file`/`audit` on D1 (see gotcha #9). Both local and prod `member` tables were restored by hand. **Inspect every migration's SQL before applying.**

## What's done (phase by phase, all verified)

- **Phase 0 — scaffold:** Next.js 16 (App Router) on Cloudflare Workers via OpenNext, Tailwind v4, TypeScript.
- **Phase 1 — tenancy (spec 0002):** Drizzle schema on D1, org-isolation wrapper (`src/server/org-db.ts`), isolation test suite (`test/isolation.test.ts`, 5 tests).
- **Phase 2 — auth (spec 0001):** Better Auth (self-hosted, **pinned to 1.4.21**) with sessions (8h rolling + 7d cap), active-org on sign-in, CSRF/origin proxy, per-account lockout, HaveIBeenPwned breach check, Resend email (console fallback), organization invitations, and 2FA (TOTP + backup codes, required for owner/admin).
- **Phase 3 — uploads (spec 0003):** presigned direct-to-R2 upload (`aws4fetch`), server-side finalize, vCard validation + normalization + publish to the public bucket, slug derivation + collision, non-vCard move to a private key, unpublish/delete, private download links, `listFiles`, and scheduled-cleanup logic + endpoint. **Republish (AC-10) was intentionally dropped** — see decisions.
- **Phase 4a — app shell:** header/nav/rail/footer to the mock, `(app)` route group with auth redirect. **Committed.**
- **Phase 4b — Upload Center:** interactive drop zone + client upload queue (concurrency 3, progress, badges, retry, copy-link), wired to the API. Duplicate-content uploads handled gracefully (409). **Committed.**
- **Phase 4c — live rail + file list:** `getRailData` (`src/server/rail.ts`) + `GET /api/rail` feed a client `SideRail` with live Storage Usage, today's Upload History, and role-scoped Recent Activity (org-wide for owner/admin, own-only for members). New `FileManager` lists the org's files (`GET /api/files`) with copy-link/download/unpublish/delete, role-gated by a server-computed `canManage`. A shared `AppDataProvider` context lets a settled upload refresh the rail + list with no page reload (AC-10). Unpublish + delete **verified in-browser.**
- **Phase 4d — dashboard, a11y, responsive, org switcher:** Dashboard rebuilt to `docs/Designs/mock-dashboard.jpg` — stat cards (team members / storage / published cards), an uploads-per-day area chart + a file-types donut (dependency-free inline SVG in `src/components/charts.tsx`), and a recent-activity feed, all from real org data via `getDashboardData` (`src/server/dashboard.ts`). No invented metrics. Org switcher in the header user menu (shown when the user is in >1 org): `getShellData` returns the caller's orgs; selecting one calls `authClient.organization.setActive` then hard-reloads so every panel reflects the new org (AC-17). Accessibility (AC-14/AC-18): the Upload Center has one polite `aria-live` region that announces start/half-way/finish/failure only, progress bars carry `role="progressbar"` + values, and a global `prefers-reduced-motion` rule neutralises motion. Responsive (AC-15): new `AppShellBody` makes the rail an off-canvas drawer behind a "Panels" control below `lg` (Esc/backdrop to close), and file rows stack + action buttons wrap so the layout holds at 360px.
- **Phase 5 — user management (spec 0005):** the Members section in `/settings` plus the missing self-service pages. Built and verified in local dev; **not yet committed or deployed.**
  - **Slice 1:** `member.status` (`active`/`suspended`) via the org plugin's `additionalFields` + migration `0004`.
  - **Prerequisite:** `requireApiRole(minRole)` in `session.ts` returns typed 401/403 for route handlers (the old `requireOrgRole` threw → 500); `requireOrgRole` now `notFound()`s on insufficient role.
  - **Slice 2:** `/accept-invitation/[id]` repaired — `previewInvite` (never leaks the email on a bad id), account create → browser sign-in → into the app, `member.joined` audit. Reuses the existing `/api/invitations/accept`.
  - **Slice 3:** roster — `listMembers` (explicit org filter, cursor pagination) + `GET /api/members` + `MembersSection` (search/filter/states, matches `mock-user-management.jpg`).
  - **Slice 4:** invitations UI — `GET /api/invitations`, invite form, `DELETE .../[id]` (revoke), `POST .../[id]/resend` (rate-limited 429), all audited (`InvitationsPanel`).
  - **Slice 5:** role change + removal — `PATCH`/`DELETE /api/members/[id]`, last-active-owner (AC-5) + self-action (AC-6) guards, inline role dropdown + Remove confirm, audited.
  - **Slice 6:** suspension — `setMemberStatus` (revokes sessions in the same action), sign-in refusal in the auth `before` hook, session-create hook prefers an active membership, Suspend/Reactivate UI.
  - **Slice 7:** detail page `/settings/users/[id]` — sign-in state, storage footprint, 2FA status; **Revoke sessions** + **Reset two-factor** actions (`getMemberDetail`, `member-actions.tsx`).
  - **Slice 8:** self-service `/forgot-password` + `/reset-password` (shared `AuthShell`) + "Forgot password?" link on sign-in.
  - **Slice 9:** `test/members.test.ts` — guards, org isolation, session revocation, audit rows.
  - **Scope extensions (beyond spec 0005, by request):** admin **Set password** + **Send reset link** on the detail page (`adminSetPassword`, `sendMemberResetLink`; the link is returned so it works without Resend), and self-service **name** editing (`ProfileSection`, Better Auth `updateUser`). Spec 0005 deliberately chose self-service-only; these override that — record in the spec's follow-up when reconciling.
- **Deploy:** live on Cloudflare **Workers Paid** plan (Free plan's 3 MiB limit was exceeded).

## Production setup (already done)

- **Remote D1 migrated** (`wrangler d1 migrations apply aw-file-storage --remote`).
- **Secrets set** (`wrangler secret put`): `BETTER_AUTH_SECRET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `CRON_SECRET`, `APP_URL` (= the workers.dev URL).
- **Vars in `wrangler.jsonc`:** `PUBLIC_FILE_DOMAIN`, `R2_ACCOUNT_ID`, `R2_PRIVATE_BUCKET`, `R2_PUBLIC_BUCKET`.
- **R2 CORS** set on `aw-files-private` for `http://localhost:3000` + the prod origin (`config/r2-cors.json`).
- **r2.dev public URL** enabled on `aw-files-public`.
- `RESEND_API_KEY` is **not** set in prod → reset/invite emails log to `wrangler tail` instead of sending (fine for now).
- Deploy command: `npm run deploy` (= `opennextjs-cloudflare build && deploy`).

## Load-bearing decisions & gotchas (don't relearn these the hard way)

1. **Better Auth pinned to 1.4.21** — the `@better-auth/cli` (schema generator) lags the runtime; keep them matched. Trade-off: no built-in 2FA-code lockout (build our own if needed). Regenerate schema after plugin/option changes: `npx @better-auth/cli@latest generate --config ./better-auth.config.ts --output ./src/server/db/auth-schema.ts -y` → `drizzle-kit generate` → `wrangler d1 migrations apply`.
2. **R2 via the S3 API (`aws4fetch`), not bindings** — remote R2 bindings need a workers.dev subdomain and broke `next dev`. `src/server/r2.ts` holds presign + server-side ops.
3. **Next 16 uses `proxy.ts` (export `proxy`), NOT `middleware.ts`.** Our CSRF/origin check is `src/proxy.ts`.
4. **`(app)` routes need `export const dynamic = "force-dynamic"`** (they read the per-request session) or the production build fails trying to prerender them.
5. **Workers Paid plan required** to deploy (bundle > 3 MiB).
6. **Dev-server orphans:** stopping the task wrapper leaves `next dev` holding port 3000. Kill by PID: `netstat -ano | grep :3000` → `taskkill //F //PID <pid>`. Always confirm the server is on 3000, not 3002.
7. **UI verification:** the user checks UI in their own browser and screenshots — don't drive claude-in-chrome for it.
8. **Custom domain — DONE.** Registered `awvcard.com` on Cloudflare. App = Worker custom domain `www.awvcard.com` (canonical `APP_URL`); apex `awvcard.com` 301→www via a Redirect Rule (needs a proxied placeholder A record `@ → 192.0.2.1`). vCards = R2 bucket `aw-files-public` custom domain `contacts.awvcard.com` (`PUBLIC_FILE_DOMAIN`). Sign-in needs the browser origin trusted: added a `TRUSTED_ORIGINS` var (comma-separated) that `auth.ts` merges into Better Auth `trustedOrigins`. Still TODO: `X-Robots-Tag: noindex` transform rule on `contacts.awvcard.com` (AC-17).
9. **D1 migration cascade wipe (DANGEROUS).** D1 runs each migration in a transaction, where SQLite **ignores `PRAGMA foreign_keys=OFF`**. So a Drizzle table-**rebuild** (emitted when a column default/constraint changes — e.g. the org quota default) does `DROP TABLE parent`, which cascade-deletes every child row (`member`, `file`, `audit_event`, …). Migration `0004` silently wiped these on local AND remote. **Always `cat` the generated SQL before applying; if it `DROP TABLE`s a parent (`organization`/`user`), hand-edit it to `ALTER TABLE` in place.** Restore a wiped membership with the `INSERT INTO member … SELECT FROM user,organization WHERE NOT EXISTS(…)` one-liner.
10. **HTTP/2 host in `proxy.ts`:** browsers send the host as the `:authority` pseudo-header (no `Host` header), so `req.headers.get("host")` was null behind Cloudflare and the CSRF check 403'd every sign-in on the custom domain. Fixed via `TRUSTED_ORIGINS` + host fallback.

## KNOWN ISSUE to fix

- **The `proxy.ts` path-exemption for `/api/cron/` and `/api/admin/` does NOT fire on the Cloudflare runtime** (the bootstrap `curl` got 403 until an `Origin` header matching `APP_URL` was added). So **machine callers must send `Origin: <APP_URL>`**. Action item: when deploying the **cron worker** (`cron/`), have its `fetch` include `Origin: <APP_URL>` rather than relying on the proxy exemption (and consider removing that exemption). Until then the cron worker will 403.

## What's next (TODO, roughly in order)

1. **Phase 5 — commit, PR/merge, then deploy.** All of Phase 5 (+ scope extensions) is uncommitted on `phase-5-user-management`. Run `npm run typecheck` + `npm test`, then commit/PR/merge. **Deploy Phase 5 to prod** (`npm run deploy`) — prod still runs Phase 4 code, so none of the user-management features are live there yet.
2. **Before deploying: re-run `migrations apply --remote`** only after confirming `0004` is already applied on prod (it is) — do NOT regenerate migrations that rebuild a parent table (see gotcha #9).
3. ~~**Phase 4c / 4d**~~ **Done.** Still open from spec 0004: ETA column (AC-5), upload table as a semantic `<table>`, leave-warning + offline pause/resume (AC-13).
4. **Deferred auth UI** — the sign-in page's **2FA code-entry step** (backend enforces 2FA but the page doesn't prompt for a code yet). accept-invitation + password-reset pages are now **built** (Phase 5).
5. **Cron worker deploy** — fix machine-endpoint auth (Origin header, see Known Issue), set `APP_URL`/`CRON_SECRET` in `cron/`, `wrangler deploy` from `cron/`.
6. `X-Robots-Tag: noindex` transform rule on `contacts.awvcard.com` (AC-17). **Multipart uploads** > 90 MB (deferred).
7. **Reconcile spec 0005** — record the two accepted deviations (admin password reset; self-service name/email edit) in its follow-up.
8. **`acceptInvite` atomicity** (D1 batch) refinement.

## Testing / running

- **Local dev:** `npm run dev` (localhost:3000). Seed a dev owner: `GET /api/dev/seed` (dev-only) → `owner@americaworks.test` / `correct-horse-battery-staple-12`.
- **Typecheck:** `npm run typecheck`. **Tests:** `npm test` (Vitest + workers pool, 5 isolation tests).
- **Prod build preflight:** `npx opennextjs-cloudflare build`.
- API flows were verified with `curl` against real R2/D1 throughout Phases 1–3; UI verified in-browser in Phase 4.
