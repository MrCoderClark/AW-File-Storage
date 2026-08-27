# AGENTS.md

AI context for the **AW File Storage** project. Read this before writing code. It records the stack, the commands, and the non negotiable conventions. The full reasoning lives in [docs/specs/0001-secure-file-storage-platform/](docs/specs/0001-secure-file-storage-platform/index.md); this file is the short version a build needs.

Status: **Phase 0–1 done, Phase 2 (auth) in progress.** Built: scaffold, the tenancy schema + org-isolation wrapper (spec 0002), and Better Auth wiring with a verified sign-in (spec 0001). Remaining in Phase 2: per-account lockout, Resend email, invitations, 2FA enrolment. Then uploads (0003) and the Upload Center UI (0004).

## What this is

An internal file storage web app. Staff sign in, upload files into private Cloudflare R2 storage, and `.vcf` contact cards are published automatically to a stable public address on `contacts.americaworks.com`. Contact data is real people's personal data, so publishing is a deliberate, audited, reversible act.

## Stack

| Layer | Choice |
|---|---|
| Language | TypeScript, strict mode |
| Framework | Next.js 16, App Router, React 19 |
| Runtime / host | Cloudflare Workers via `@opennextjs/cloudflare` (`nodejs_compat` on) |
| Database | Cloudflare D1 (SQLite), bound to the Worker |
| ORM | Drizzle ORM (`drizzle-orm/d1`) — **not** Prisma |
| Migrations | `drizzle-kit generate` → SQL in `migrations/` → `wrangler d1 migrations apply` |
| Auth | Better Auth **pinned to 1.4.21** (to match `@better-auth/cli`, which lags the runtime), self hosted, D1 (Drizzle) adapter, `organization` + `twoFactor` + `haveIBeenPwned` + `nextCookies` plugins — **not** hand written, **not** a hosted IdP |
| File storage | Two R2 buckets: `aw-files-private` (staging + private) and `aw-files-public` (published vCards, on `contacts.americaworks.com`) |
| Uploads | Presigned S3 style `PUT` straight from browser to the private bucket (signed with `aws4fetch`), multipart above 90 MB |
| Background work | Cloudflare Queues (validate/promote), Cron Triggers (nightly cleanup + reconciliation) |
| Email | Resend, over `fetch` |
| UI | Tailwind CSS v4 (`@theme`) + shadcn/ui, matching `docs/Designs/mock1.jpg` |
| Validation | Zod, shared by server actions and forms |
| Testing | Vitest with `@cloudflare/vitest-pool-workers` (real bindings), Playwright for e2e |
| Errors / logs | Workers Logs (`observability.enabled`) + Sentry (`@sentry/cloudflare`) + the D1 audit log |

Architecture: one Next.js app (a monolith, no microservices), layered as routes → services → repositories.

## The rules that bind everything (do not violate)

1. **Tenant isolation.** Every tenant table carries a non null `org_id`, every index leads with it, and tenant data is reached **only** through the organization scoped wrapper `orgDb(orgId)` in `src/server/org-db.ts`. Never query a tenant table on the raw client. The `orgId` comes from `session.activeOrganizationId` (Better Auth), never from the request body. See spec 0002.
2. **One way to know the caller.** `getSession()` and `requireOrgRole(role)` (in `src/server/auth.ts`) are the only ways feature code learns who the caller is or gates on a role. Nothing else parses the cookie or reads `member.role`. See spec 0001.
3. **A file is never public until the server validated it.** The browser only ever writes to the private bucket under `incoming/`. Only the Worker writes to the public bucket, and only a validated, normalised single vCard. See spec 0003.
4. **Every state changing action writes one audit row** through the insert only audit helper, before returning success. The `audit_event` table is never updated or deleted by application code.
5. **All DB access goes through Drizzle in `src/server/db.ts`**, built per request from the D1 binding. Better Auth uses that same client through its adapter. No raw `env.DB.prepare` in feature code.
6. **Don't re-implement Better Auth primitives.** Use its scrypt hashing, its cookie flags, its origin/CSRF check, its rate limiter, its session revocation. Configure it (see `src/server/auth.ts` in spec 0001); do not hand roll hashing or tokens. Never set `disableCSRFCheck` or `disableOriginCheck`.

## Secrets and config (Worker secrets via `wrangler secret put`; `.dev.vars` locally, never in git)

`BETTER_AUTH_SECRET` (or `BETTER_AUTH_SECRETS` for rotation), `APP_URL`, `RESEND_API_KEY`, `EMAIL_FROM`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PRIVATE_BUCKET`, `R2_PUBLIC_BUCKET`, `CF_API_TOKEN`, `CF_ZONE_ID`. Non secret defaults: `PUBLIC_FILE_DOMAIN`, `MAX_UPLOAD_BYTES` (5 GiB), `MAX_VCARD_BYTES` (256 KB), `MULTIPART_THRESHOLD_BYTES` (90 MB), `NEXT_PUBLIC_APP_NAME`.

## Commands

> These are the intended commands for the scaffold; wire them in `package.json` when it lands.

```
npm run dev                       # next dev (local Workers runtime)
npm run build                     # opennextjs-cloudflare build
npm run deploy                    # wrangler deploy
npx drizzle-kit generate          # generate a migration from the Drizzle schema
npx wrangler d1 migrations apply <DB>   # apply migrations (add --local for local D1)
npx @better-auth/cli generate     # generate Better Auth's tables into the schema
npm run test                      # vitest (workers pool, real bindings)
npm run test:e2e                  # playwright
npm run typecheck && npm run lint
```

Two Cloudflare environments, `staging` and `production`, with separate D1 databases and R2 buckets. Migrations run before the code that needs them.

## Environment notes

- **This is a Windows machine; the shell is PowerShell.** Prefer cross platform npm scripts. See the `powershell-windows` skill for shell pitfalls.
- **Next 16 uses `proxy.ts` (export `proxy`), NOT `middleware.ts`.** The middleware convention is deprecated; our CSRF/origin check lives in `src/proxy.ts`.
- **Better Auth is pinned to 1.4.21.** `@better-auth/cli` (schema generator) lags the runtime; keeping them matched avoids schema drift. Trade-off: no built-in 2FA-code lockout (dropped in migration 0003) — build it ourselves like the password lockout (AC-7). Bump both together when the CLI catches up.
- After changing Better Auth plugins/options, regenerate the schema with `npx @better-auth/cli@latest generate --config ./better-auth.config.ts --output ./src/server/db/auth-schema.ts -y`, then `drizzle-kit generate` + `wrangler d1 migrations apply`.
- **R2 is accessed via the S3 API (`aws4fetch`), not the Worker bindings** — presigned URLs for the browser (`src/server/r2.ts`), signed requests server-side (`r2Head`, etc.). Reason: remote R2 bindings in local dev require a registered workers.dev subdomain and broke `next dev`; the S3 API hits the same real bucket everywhere with no extra setup. The `FILES_PRIVATE`/`FILES_PUBLIC` bindings stay declared (local) but unused for now.
- Better Auth's `rateLimit.storage` must be `"database"` — its default in memory store does not survive across Worker isolates.
- The `auth` instance and the Drizzle client are built **per request** from `env`, because the D1 binding only exists per request.
- `nextCookies()` must be the **last** Better Auth plugin so server actions can set the cookie.
- Kill a stray `next dev` by PID (`netstat -ano | grep :3000` → `taskkill //F //PID <pid>`); stopping the task wrapper alone can leave the process holding the port.

## Skills to use

`tailwindcss-v4` and `frontend-design` for UI, `playwright` for e2e, `powershell-windows` for the shell. Installing Cloudflare Workers/Wrangler, Drizzle, and Better Auth skills is a recommended follow up (see the spec's Follow-up list).

## Specs

- [index.md](docs/specs/0001-secure-file-storage-platform/index.md) — the stack decision and cross cutting contract
- [0001 — Authentication](docs/specs/0001-secure-file-storage-platform/0001-authentication-and-sessions.md) — Better Auth config + hardening
- [0002 — Tenancy & data model](docs/specs/0001-secure-file-storage-platform/0002-tenancy-and-data-model.md) — schema + isolation (build first)
- [0003 — Uploads & public vCard URLs](docs/specs/0001-secure-file-storage-platform/0003-uploads-and-public-vcard-urls.md)
- [0004 — Upload Center UI](docs/specs/0001-secure-file-storage-platform/0004-upload-center-ui.md)
- [rationale.md](docs/specs/0001-secure-file-storage-platform/rationale.md) — why (a build never needs this)

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
