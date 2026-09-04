# 0001. Secure file storage platform on Cloudflare

**Date**: 2026-08-26
**Status**: Proposed

## Summary

This is the foundation decision for a new internal file storage web app. Staff sign in, upload files into private Cloudflare R2 storage (R2 is object storage, meaning a bucket that holds files, not a database), and vCard files (`.vcf`, the contact card format phones understand) are published automatically to a stable public web address on `contacts.americaworks.com`. The whole thing runs on Cloudflare: a Next.js app on Cloudflare Workers, records in Cloudflare D1 (a small SQL database), files in two R2 buckets. Login is handled by Better Auth, a self hosted open source authentication library that runs inside our own Worker and keeps every user and session row in our own D1 — proven primitives instead of hand written cryptography, configured the secure way in child 0001.

## Structure

This decision is large enough that it is split into an umbrella (this file, the stack) plus seven child specs. Each child is complete enough to build from on its own.

| Child spec | What it is | Which decision it supports |
|---|---|---|
| [0001-authentication-and-sessions.md](0001-authentication-and-sessions.md) | Login on Better Auth: how it is configured for the Workers/D1 runtime, and the hardening we add on top (12 char minimum, breach check, per account lockout, near instant revocation, required second factor for admins) | The `Auth` row of `## Proposed stack` |
| [0002-tenancy-and-data-model.md](0002-tenancy-and-data-model.md) | Organizations, roles, and the full D1 schema every other child depends on | The `Primary DB` and `Tenancy` rows |
| [0003-uploads-and-public-vcard-urls.md](0003-uploads-and-public-vcard-urls.md) | Direct to R2 uploads, the validate then publish pipeline, and the public vCard address | The `File storage` row, and the product goal |
| [0004-upload-center-ui.md](0004-upload-center-ui.md) | The Upload Center screen from `docs/Designs/mock1.jpg`, plus the app shell | The `UI` row |
| [0005-user-management.md](0005-user-management.md) | The Members section in Settings: roster, per person detail, invitations you can send, revoke, and resend, account lifecycle (suspend, reactivate, remove, revoke sessions, reset second factor), and self service password reset | The `Auth` and `Tenancy` rows, extended to the people who administer them |
| [0006-create-card-form.md](0006-create-card-form.md) | A Create Card form (3-step wizard) that builds a vCard from typed fields and publishes it through the existing pipeline — no `.vcf` file needed | The product goal, extending the `File storage` / publish path |
| [0007-files-view.md](0007-files-view.md) | A dedicated Files page: browse/search/filter all files, a richer table (uploader, size, modified), and per-row + bulk management (rename, download, unpublish, delete) | The `UI` row, extending file management beyond the Upload Center |
| [0008-public-card-landing-and-analytics.md](0008-public-card-landing-and-analytics.md) | A styled public landing page per published card (Add to contacts, tap to call, socials) plus per card view/scan/download counts, by moving `contacts.awvcard.com` onto the app Worker | The product goal and the `UI` row, extending the public vCard path with a page and engagement analytics |
| [0009-host-based-card-page-access.md](0009-host-based-card-page-access.md) | Serve `/c/*` publicly only on `contacts.awvcard.com`; require login on the app host (`www`) and count only public-host traffic, so the app domain is not a second public directory and staff previews never inflate counts | Refines spec 0008's access + counting model along the `Auth` and product-goal rows |
| [0010-office365-card-url-sync.md](0010-office365-card-url-sync.md) | Automatically write each published card's public `.vcf` URL into the staff member's Exchange `CustomAttribute1` via Microsoft Graph (app-only), on publish/edit and a nightly reconcile, and clear it on unpublish/delete | Extends the product goal, connecting the published card path to Office 365 |
| [0011-o365-certificate-auth-least-privilege.md](0011-o365-certificate-auth-least-privilege.md) | Harden spec 0010: authenticate to Graph with a certificate instead of a client secret, and scope the app to an Administrative Unit via a custom role instead of tenant-wide `User.ReadWrite.All` | Security hardening of the `Auth` row for the Office 365 integration |
| [0012-org-isolation-and-lifecycle.md](0012-org-isolation-and-lifecycle.md) | Prove/harden multi-tenant isolation (per-org settings, fold stray tables behind the `orgDb` wrapper, an import-guard test) and add org lifecycle UI (switcher, rename, delete, platform-owner-gated create) | Hardens the `org_id` isolation contract and extends the `UI`/tenancy rows |
| [0013-per-org-o365-credentials.md](0013-per-org-o365-credentials.md) | Each org brings its OWN Entra app (tenant + client id + secret/cert), stored encrypted per-org; retire the global `GRAPH_*` so no org is special or visible to another | Makes the Office 365 integration genuinely per-tenant, replacing the single-tenant creds of specs 0010/0011 |
| [0014-membership-and-provisioning.md](0014-membership-and-provisioning.md) | A platform-owner provisioning console: add users (new + existing) to orgs, with the org suggested from the email's verified Microsoft domain; invite → accept unchanged | Builds the membership/onboarding layer on the tenancy + Office 365 foundations |

**Cross child contract** (rules that bind all five children together):

1. **Every tenant scoped row carries `org_id`, and every query filters on it.** No exceptions, including the audit log. Child 0002 owns the column, children 0001, 0003, and 0004 must honour it.
2. **One session helper is the only way to learn who the caller is.** Child 0001 exports `getSession()` (wrapping Better Auth's `auth.api.getSession`) and `requireOrgRole(role)`. Children 0003 and 0004 never read the cookie or call Better Auth for authorization themselves.
3. **A file is never public until the server has validated it.** The browser only ever writes to the private staging area. Child 0003 owns the promotion step; nothing else may write to the public bucket.
4. **Every state changing action writes one audit row** through the helper in child 0002, before returning success.
5. **All database access goes through Drizzle in a single `src/server/db.ts` module** that builds the client from the Worker's D1 binding per request, and tenant data goes through the organization scoped wrapper in child 0002. No raw `env.DB.prepare` calls in feature code. Better Auth uses the same Drizzle client through its adapter.

## Requirements

This umbrella is a decision spec, so it carries no acceptance criteria of its own. The buildable criteria live in the four child specs. What the platform as a whole must deliver, in plain words:

**User stories**:
- As an internal staff member, I want to sign in with an account an admin created for me, so that only our people can see our files.
- As a staff member, I want to drag a `.vcf` contact card into the app and immediately get a public web address for it, so that I can put that address behind a QR code on a business card.
- As an admin, I want every other file type to stay private, so that uploading the wrong document does not leak it.
- As an admin, I want to see who uploaded, published, or deleted what, so that I can answer a question about our data six months later.

## Decision

**Chosen option**: All on Cloudflare, Next.js on Workers with D1 and R2, login on the self hosted Better Auth library. (This is Option 2 in [rationale.md](rationale.md); the project initially chose Option 1's hand written login and then adopted the recommended library.)

Build a single Next.js application (one deployable unit, no microservices) that runs on Cloudflare Workers through the OpenNext adapter, stores its records in Cloudflare D1 through Drizzle ORM, stores files in two R2 buckets (one private, one public and served on `contacts.americaworks.com`), and uses Better Auth (self hosted, keeping user and session rows in our own D1) for login rather than a hosted identity provider or hand written code.

**Implementation skills**: `tailwindcss-v4` (`C:\Users\jclark\.agents\skills\tailwindcss-v4\`) · `frontend-design` (`C:\Users\jclark\.agents\skills\frontend-design\`) · `playwright` (`C:\Users\jclark\.agents\skills\playwright\`) · `powershell-windows` (`C:\Users\jclark\.codeium\windsurf\skills\powershell-windows\`)

## Rationale

Reasoning, the options weighed, and the premise notes: see [rationale.md](rationale.md).

## Proposed stack

| Layer | Choice | Reason |
|---|---|---|
| Language | TypeScript, strict mode | One language across server and browser, and the Workers runtime is a JavaScript runtime, so there is no second language to justify. |
| Framework | Next.js 15, App Router, React 19 | Your stated choice, and its server components plus server actions remove the need for a separate API tier on a small team. |
| Runtime and hosting | Cloudflare Workers via `@opennextjs/cloudflare`, with `nodejs_compat` on | The Cloudflare dashboard "Create app" flow you showed is this. It puts the app in the same account as R2 and D1, so both are bound directly with no egress fee and no public database endpoint. |
| Primary DB | Cloudflare D1 (SQLite) | Your choice. Bound to the Worker with no connection pool to manage, which is the usual pain of a serverless app talking to a normal database. Its limits are accepted knowingly, see rationale. |
| Database toolkit | Drizzle ORM with `drizzle-orm/d1` over the D1 binding | The low friction, well trodden pairing with D1: it runs directly on the binding with no preview driver adapter, stays light in the Worker bundle, and is the first class database choice for Better Auth's adapter. Chosen over Prisma on D1, which needs a preview adapter, cannot apply its own migrations, and is heavier in a size limited bundle. |
| Migrations | `drizzle-kit generate` produces SQL into `migrations/`, applied by `wrangler d1 migrations apply`; Better Auth's own tables are generated by its CLI and folded into the same migration flow | Wrangler is the supported applier for D1, so the SQL files are the source of truth in git. |
| Auth | Better Auth, self hosted in the Worker, with the D1 (Drizzle) adapter and the `organization`, `twoFactor`, and `nextCookies` plugins | Proven, audited primitives (scrypt hashing, session revocation, origin/CSRF checks, rate limiting, enumeration protection) instead of hand written cryptography, while every user row still lives in our own D1 with no per user fee. Child 0001 pins the secure configuration and the hardening we add. |
| File storage | Two R2 buckets: `aw-files-private` (staging plus private files) and `aw-files-public` (published vCards only), both bound to the Worker | Object storage never belongs in a database, and a hard bucket boundary is the only way to guarantee a private file cannot be reached by guessing a URL. |
| Public file delivery | R2 custom domain `contacts.americaworks.com` on the public bucket, fronted by the Cloudflare cache | A published vCard is served by Cloudflare with zero Worker compute and zero per request cost, and the address stays stable forever. |
| Upload transport | Presigned S3 style `PUT` straight from the browser to the private bucket, multipart above 90 MB | File bytes never pass through the Worker, so Worker request size limits, CPU time, and timeouts stop being an upload ceiling. |
| Background work | Cloudflare Queues for post upload processing (validate, promote, thumbnail later), Cron Triggers for nightly cleanup | Validation must not block the browser, and a queue on the platform we are already on costs no new infrastructure to operate. |
| Email | Resend, called over `fetch` from the Worker | Invites, password reset, and verification are required by our own auth. Resend has the simplest API that works from a Worker, and templates can be React. |
| UI | Tailwind CSS v4 plus shadcn/ui components, matching `docs/Designs/mock1.jpg` | Copy paste components we own outright, no component library upgrade treadmill, and a v4 skill is already installed. |
| Validation | Zod schemas shared by server actions and forms | One schema defines both the browser check and the server check, so they cannot drift apart. |
| Observability | Workers Logs with `observability.enabled`, plus Sentry via `@sentry/cloudflare` for errors, plus our own audit log in D1 | Three different jobs: live tailing, error alerting, and a durable record of who did what. The audit log is a compliance requirement, not telemetry. |
| Rate limiting | Cloudflare WAF rate limiting rules on the auth routes, plus per account lockout counters in D1 | Two layers, because a network rule cannot see which account is under attack and a database counter cannot cheaply absorb a flood. |
| Secrets | `wrangler secret put`, with `.dev.vars` for local work and never in git | The only mechanism the platform offers, and it keeps the R2 signing keys out of the repository. |
| Testing | Vitest with `@cloudflare/vitest-pool-workers` for unit and integration, Playwright for end to end | Tests run inside the real Workers runtime with real D1 and R2 bindings, so a test passing on Node but failing on deploy stops happening. |
| CI and deploy | GitHub Actions: typecheck, lint, test, `wrangler d1 migrations apply`, then `wrangler deploy` | One pipeline, and migrations always run before the code that needs them. |
| Environments | Two Cloudflare environments, `staging` and `production`, with separate D1 databases and buckets | Nobody tests a destructive migration against real customer contact data. |

**Architecture pattern**: a single layered application (routes call services, services call repositories). Fewer than five engineers and no measured bottleneck means there is nothing a service split would buy, and it cannot easily be undone.

## Consequences

**Positive**:
- One vendor, one bill, one dashboard, one deploy command. The app, the database, the files, the queue, the cache, and the DNS are all in the account you already have open.
- Published vCard addresses are served from Cloudflare's edge cache with no compute cost, and they stay stable even when the file behind them is replaced, which is what makes them safe to print on a business card.
- Private files are unreachable without a signed link because they live in a bucket with no public domain at all, not merely behind an access check.
- Every file byte travels browser to R2 directly, so upload size is limited by our own policy rather than by a platform request limit.

**Negative and tradeoffs**:
- **We self host our login, so we own its configuration and its upgrades.** The dangerous primitives (hashing, session rotation, reset tokens, enumeration, rate limiting) are Better Auth's and are attacked by more people than just us, which is the whole reason to use it. What remains ours is configuring it correctly (child 0001 pins that), keeping it patched, and owning its release cadence and occasional breaking changes. This is a far shorter and more reviewable risk than hand written cryptography, but it is not zero: a dependency in the most sensitive part of the system still has to be watched.
- **D1 is not Postgres.** It is SQLite with a per database size cap, no `JSONB`, weaker concurrent write behaviour, and a query result size limit. Reporting over millions of audit rows will eventually need a different home, and moving off D1 later means a real migration.
- **Next.js on Workers is not Next.js on Vercel.** The OpenNext adapter lags Next.js releases, some Node built ins are unavailable or partial, and an upgrade can be blocked by the adapter rather than by our own code.
- Two buckets means a copy step and two places a file can be, so an orphaned object is now a failure mode we have to sweep up on a schedule.
- Publishing a vCard publishes a real person's name, phone, and email to an address anyone can fetch. That is the whole point of the product, and it is still personal data leaving the building, so publish and unpublish are audited and the public responses are marked not to be indexed by search engines.

**Neutral**:
- The team learns Wrangler, bindings, and the Cloudflare mental model, which is genuinely different from a normal Node deployment.
- The repository has no `AGENTS.md` yet, so conventions live only in these specs until one is generated.
- The mock says up to 10 GB per file. The spec supports it through multipart upload but sets the default cap far lower, because nobody should discover a 10 GB accident after it happens.

## Follow-up

- [ ] **Confirm Better Auth runs cleanly on the Workers runtime with the D1 (Drizzle) adapter before feature work.** Prove sign in, session, the `organization` and `twoFactor` plugins, the `nextCookies` plugin for server actions, and database backed rate limiting (memory storage does not survive across isolates), with the Worker bundle still under the size limit. Pin the Better Auth version once proven.
- [ ] **Review the Better Auth configuration against the child 0001 checklist and OWASP.** The risk moved from writing cryptography to configuring a library; the review is now of `src/server/auth.ts` (origin/CSRF, session lifetime, `disableSignUp`, breach check, required second factor, secret handling) rather than of hand written hashing.
- [ ] **Confirm the OpenNext adapter supports the Next.js version we pin**, before pinning it.
- [ ] No `AGENTS.md` exists in this repository. Generate one once the scaffold lands, so the stack, the commands, and the conventions in these specs stop living only here.
- [ ] A Cloudflare Workers and Wrangler skill, a Drizzle skill, and a Better Auth skill are not installed but would materially improve build guidance for this stack. Consider installing them.
- [ ] `tailwindcss-v4`, `frontend-design`, `playwright`, and `powershell-windows` conventions are not yet referenced in a root `AGENTS.md`. Tailwind belongs at root level (it affects every component). The others are area or environment scoped.
- [ ] Decide the storage quota per organization before launch. The mock shows 5 TB, which is a design placeholder, not a decision.
- [ ] Decide the product name. The mock says "OmniDrive Enterprise", which is placeholder text. The header currently reads from `NEXT_PUBLIC_APP_NAME`.
- [ ] Generating a QR code image for a published vCard address is the obvious next feature, given that a printed QR code is the stated use for these addresses. It is deliberately out of this release and wants its own small spec.
- [ ] Not decided, and not blocking the first release: virus scanning on upload, file versioning beyond the vCard republish case, and SAML or SCIM single sign on for a future external tenant. Each is its own spec when it is needed.
