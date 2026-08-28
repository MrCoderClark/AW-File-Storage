# Progress & handoff — AW File Storage

Living status doc for session continuity. Read this + [AGENTS.md](../AGENTS.md) +
the specs in [docs/specs/](specs/0001-secure-file-storage-platform/index.md)
before continuing. Last updated: **2026-08-28**.

## TL;DR — where we are

**The app is BUILT and DEPLOYED to production, and the full product loop works.**
Drop a `.vcf` in the browser → it uploads directly to R2 → validates → publishes
→ resolves at a live public URL. Non-vCard files stay private with signed
download links. Auth, tenancy, uploads, and publishing are all done and verified.

- **Live app:** https://aw-file-storage.aw-file-storage.workers.dev
- **Owner account:** `jclark@americaworks.com` (created via the bootstrap endpoint)
- **Public vCard URLs:** `https://pub-b2056b2349884431a72f9ff1c895e0fa.r2.dev/c/<slug>.vcf`
- **Branch:** `phase-4-ui` (4a + 4b + deploy-setup + 4c committed; 4d done, **not yet committed**)

## What's done (phase by phase, all verified)

- **Phase 0 — scaffold:** Next.js 16 (App Router) on Cloudflare Workers via OpenNext, Tailwind v4, TypeScript.
- **Phase 1 — tenancy (spec 0002):** Drizzle schema on D1, org-isolation wrapper (`src/server/org-db.ts`), isolation test suite (`test/isolation.test.ts`, 5 tests).
- **Phase 2 — auth (spec 0001):** Better Auth (self-hosted, **pinned to 1.4.21**) with sessions (8h rolling + 7d cap), active-org on sign-in, CSRF/origin proxy, per-account lockout, HaveIBeenPwned breach check, Resend email (console fallback), organization invitations, and 2FA (TOTP + backup codes, required for owner/admin).
- **Phase 3 — uploads (spec 0003):** presigned direct-to-R2 upload (`aws4fetch`), server-side finalize, vCard validation + normalization + publish to the public bucket, slug derivation + collision, non-vCard move to a private key, unpublish/delete, private download links, `listFiles`, and scheduled-cleanup logic + endpoint. **Republish (AC-10) was intentionally dropped** — see decisions.
- **Phase 4a — app shell:** header/nav/rail/footer to the mock, `(app)` route group with auth redirect. **Committed.**
- **Phase 4b — Upload Center:** interactive drop zone + client upload queue (concurrency 3, progress, badges, retry, copy-link), wired to the API. Duplicate-content uploads handled gracefully (409). **Committed.**
- **Phase 4c — live rail + file list:** `getRailData` (`src/server/rail.ts`) + `GET /api/rail` feed a client `SideRail` with live Storage Usage, today's Upload History, and role-scoped Recent Activity (org-wide for owner/admin, own-only for members). New `FileManager` lists the org's files (`GET /api/files`) with copy-link/download/unpublish/delete, role-gated by a server-computed `canManage`. A shared `AppDataProvider` context lets a settled upload refresh the rail + list with no page reload (AC-10). Unpublish + delete **verified in-browser.**
- **Phase 4d — dashboard, a11y, responsive, org switcher:** Dashboard now renders live storage + recent activity from `getRailData` (no more placeholders). Org switcher in the header user menu (shown when the user is in >1 org): `getShellData` returns the caller's orgs; selecting one calls `authClient.organization.setActive` then hard-reloads so every panel reflects the new org (AC-17). Accessibility (AC-14/AC-18): the Upload Center has one polite `aria-live` region that announces start/half-way/finish/failure only, progress bars carry `role="progressbar"` + values, and a global `prefers-reduced-motion` rule neutralises motion. Responsive (AC-15): new `AppShellBody` makes the rail an off-canvas drawer behind a "Panels" control below `lg` (Esc/backdrop to close), and file rows stack + action buttons wrap so the layout holds at 360px.
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
8. **Custom domain deferred:** `americaworks.com` DNS is at **Network Solutions** with production Office 365 email — do NOT move the apex. Options: register a small dedicated domain on Cloudflare, or delegate `contacts.americaworks.com` (finicky on Free). For now the `r2.dev` URL is used; switching is a one-line `PUBLIC_FILE_DOMAIN` change (objects don't move). The vCard URL is stored in the user's Exchange "Other Attribute" and turned into a barcode, so a changing URL on update is fine.

## KNOWN ISSUE to fix

- **The `proxy.ts` path-exemption for `/api/cron/` and `/api/admin/` does NOT fire on the Cloudflare runtime** (the bootstrap `curl` got 403 until an `Origin` header matching `APP_URL` was added). So **machine callers must send `Origin: <APP_URL>`**. Action item: when deploying the **cron worker** (`cron/`), have its `fetch` include `Origin: <APP_URL>` rather than relying on the proxy exemption (and consider removing that exemption). Until then the cron worker will 403.

## What's next (TODO, roughly in order)

1. **Commit the deploy setup** if not already: `git add -A && git commit -m "chore(deploy): Cloudflare Workers production setup"` (force-dynamic, prod vars, `src/app/api/admin/bootstrap/route.ts`, proxy edit, prod CORS).
2. ~~**Phase 4c** — rail + file list.~~ **Done** — see What's done. (Dashboard page still shows placeholders; its live overview is a small follow-up reusing `getRailData`.)
3. ~~**Phase 4d** — dashboard live overview, accessibility, responsive, org switcher.~~ **Done** — see What's done. Still open from spec 0004: the ETA column (AC-5), the upload table as a semantic `<table>` with caption (currently a labelled list), and the leave-warning + offline pause/resume (AC-13).
4. **Cron worker deploy** — fix machine-endpoint auth (Origin header, see Known Issue), set `APP_URL`/`CRON_SECRET` in `cron/`, `wrangler deploy` from `cron/`.
5. **Deferred auth UI** — the sign-in page's **2FA code-entry step** (backend enforces 2FA but the page doesn't prompt for a code yet), plus password-reset and accept-invitation pages, and the session-management screen (AC-16).
6. **Custom domain** for vCard URLs (when ready) + `X-Robots-Tag: noindex` transform rule (AC-17).
7. **Multipart uploads** > 90 MB (deferred; most files are tiny).
8. **`acceptInvite` atomicity** (D1 batch) refinement.

## Testing / running

- **Local dev:** `npm run dev` (localhost:3000). Seed a dev owner: `GET /api/dev/seed` (dev-only) → `owner@americaworks.test` / `correct-horse-battery-staple-12`.
- **Typecheck:** `npm run typecheck`. **Tests:** `npm test` (Vitest + workers pool, 5 isolation tests).
- **Prod build preflight:** `npx opennextjs-cloudflare build`.
- API flows were verified with `curl` against real R2/D1 throughout Phases 1–3; UI verified in-browser in Phase 4.
