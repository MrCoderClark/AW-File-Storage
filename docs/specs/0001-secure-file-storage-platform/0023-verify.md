# 0023 — Verification

**Done 2026-09-08.** Better Auth upgraded 1.4.21 → **1.7.3**, verified live in production
(login + 2FA both work), `npm audit` critical bundle cleared.

## What the upgrade actually required

- **The pin's real cause:** the standalone `@better-auth/cli` was **deprecated and frozen at
  1.4.21**; that freeze (not any runtime/Cloudflare conflict) is why the pin existed. The app
  had run 1.7.2 on this stack before, so 1.7.x was already proven here.
- **CLI moved:** schema generation is now the `auth` package —
  `npx auth@1.7.3 generate --config ./better-auth.config.ts --output ./src/server/db/auth-schema.ts --adapter drizzle --dialect sqlite -y`
  — versioned in lockstep with the runtime.
- **Drizzle adapter extracted** (1.5 breaking change): `better-auth/adapters/drizzle` →
  `@better-auth/drizzle-adapter`. Import updated in 6 files: `better-auth.config.ts`,
  `src/server/auth.ts`, `src/server/invitations.ts`, `src/server/members.ts`,
  `src/app/api/dev/seed/route.ts`, `src/app/api/admin/bootstrap/route.ts`.
- **Client type change:** `authClient.twoFactor.enable` now returns a discriminated union
  keyed by `method`; `src/app/enroll-2fa/page.tsx` narrows on `data.method === "totp"` before
  reading `totpURI`/`backupCodes`. Caught by `npm run typecheck`.

## Migration (gotcha #9 gate — the important part)

`drizzle-kit generate` produced `0022_famous_kat_farrell.sql`, which **rebuilt `organization`
and `member`** (`DROP TABLE` + recreate) purely to add cosmetic `NOT NULL` to columns that
already exist, default, and are populated. On D1 that would have **cascade-wiped
member/file/audit/…** (`PRAGMA foreign_keys=OFF` is ignored inside the migration transaction).
The migration was **hand-edited** to keep only the three additive `two_factor` columns
(`verified`, `failed_verification_count`, `locked_until` — 1.7's built-in 2FA-code lockout).
The drizzle meta snapshot was left as generated, so a future `generate` sees no diff and won't
re-emit the rebuild.

## Deploy + CSP interaction

Applied remote (additive only, safe with 1.4.21 still live), then deployed 1.7.3. The enforced
app CSP (spec 0020) `connect-src` had to also allow the R2 S3 endpoint, because Upload Center
and Create Card PUT bytes **directly to R2** from the browser — otherwise uploads fail under
enforcement. Added `https://<account>.r2.cloudflarestorage.com` to `connect-src` in
`next.config.ts`.

## Checks (all passed)

- `npm run typecheck` clean; `npm test` green.
- Live: sign in, **2FA TOTP code step** (incl. a wrong code — 1.7 lockout), enroll/disable 2FA,
  invite accept, member actions + owner-tier guards (0021), org switch.
- Live: a file upload (Upload Center) and a Create Card publish — the direct-to-R2 PUT succeeds
  under the enforced CSP.
- `npm audit`: the `better-auth` critical bundle is gone (only the accepted esbuild/drizzle-kit
  dev-chain moderate remains).

## Not an app issue (recorded to stop future confusion)

A console `TypeError: … reading 'startTime'` (web-vitals `onINP`) that surfaced during testing
is injected by the **browser's DevTools** (`window.devToolsReportSoftNavs`), not the app —
`web-vitals` is not in the dependency tree, and it does not appear in the served HTML. It only
runs with DevTools open; real visitors never see it. Nothing to fix in the app.
