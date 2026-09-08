# 0023. Upgrade Better Auth off the pinned 1.4.21 to a patched release

**Date**: 2026-09-08
**Status**: Proposed

## Summary

`npm audit` reports a **critical** advisory bundle against `better-auth <= 1.7.0-rc.6`
(ten CVEs). The app is pinned to **1.4.21** (deliberately, to match `@better-auth/cli`,
which lags the runtime). Almost every advisory is for a Better Auth feature this app does
not enable, and the one that touches a plugin we use is blocked by our configuration, so
there is **no currently reachable exploit** — but the clean way to clear a critical is to
upgrade to a patched line (currently `1.7.3`), not to leave a flagged dependency forever.
This spec captures that upgrade as its own **carefully tested** task, because a blind
`npm audit fix --force` would break the pin and, worse, could run an unreviewed schema
migration on D1 (the cascade-wipe hazard).

## Context

Assessed reachability of the ten advisories against this app's actual Better Auth config
(email + password, `disableSignUp: true`, plugins `organization` + `twoFactor` +
`haveIBeenPwned` + `nextCookies`):

| Advisory group | Requires | Enabled here? |
|---|---|---|
| OAuth state mismatch; OAuth auto-link takeover; refresh-token rotation/replay | OAuth / social sign-in | No — email+password only |
| `oidcProvider` alg=none; `redirect_uri` stored XSS | `oidcProvider` plugin | No |
| `oauth-provider` concurrent redemption | `oauth-provider` plugin | No |
| magic-link / email-OTP pre-account hijack | `magicLink` / `emailOTP` | No |
| stale sessions after deletion | `admin` / `anonymous` / SCIM | No |
| **invitation accept via unverified email** | `organization` plugin | **Yes** — but mitigated by `disableSignUp: true` (accounts come only from invites) + `requireEmailVerification: true` |

So the effective risk to the deployed app is negligible today. The residual reason to act
is hygiene and defence in depth: get off a version with a standing critical bundle.

**Why this is not an `npm audit fix`:**
1. The fix installs `better-auth@1.7.3`, "outside the stated dependency range" — it breaks
   the intentional **1.4.21 pin** (now hard-pinned exact in `package.json` so audit-fix
   cannot bump it, spec 0022 dependency pass).
2. `@better-auth/cli` (the schema generator) must move **in lockstep** with the runtime, or
   the generated `auth-schema.ts` drifts from what the library expects.
3. A version jump this size almost certainly changes Better Auth's own tables, so it emits a
   **migration**. On D1 a Drizzle table **rebuild** of a Better Auth parent table
   (`user`/`organization`) silently cascade-deletes child rows (`member`, `file`,
   `audit_event`, …) — the documented gotcha #9 that has bitten this project before. An
   unreviewed forced upgrade could wipe production data.

## Requirements

**User story**:
- As the platform owner, I want the app on a Better Auth release with no standing critical
  advisory, upgraded without breaking sign-in, invitations, 2FA, or losing any data.

**Acceptance criteria**:
- **AC-1 (version + CLI lockstep)**: `better-auth` and `@better-auth/cli` are both moved to
  the same patched version (>= `1.7.3`, or the current patched line at implementation time).
  `package.json` keeps an **exact** pin (no caret) so future installs can't drift it.
- **AC-2 (schema regenerated in lockstep)**: `auth-schema.ts` is regenerated with the
  matching CLI (`npx @better-auth/cli@<version> generate …`), then `drizzle-kit generate`
  produces the migration.
- **AC-3 (migration inspected — MANDATORY)**: the generated migration SQL is read **before**
  applying. If it `DROP TABLE`s any Better Auth parent (`user`, `organization`), it is
  hand-edited to `ALTER TABLE` in place so no child rows cascade-delete (gotcha #9). Applied
  to **local first**, verified, then `--remote`.
- **AC-4 (auth flows retested in local dev)**: sign-in (incl. the 2FA code step), invitation
  accept, password reset, org switching, member suspend/role change, and the owner-tier
  guards (spec 0021) all still work against the upgraded library before any deploy.
- **AC-5 (advisory cleared)**: `npm audit` no longer reports the `better-auth` critical
  bundle. Any new advisory the upgrade introduces is re-triaged.
- **AC-6 (config re-review)**: after the upgrade, re-confirm the hardened options still apply
  and no new insecure default slipped in (`disableSignUp`, `requireEmailVerification`,
  `rateLimit.storage: "database"`, session lifetimes, `nextCookies()` last, no
  `disableCSRFCheck`/`disableOriginCheck`). Check the 1.5→1.7 changelogs for behavioural
  changes to the `organization` and `twoFactor` plugins.

## Decision

**Chosen approach**: a dedicated upgrade session (not a forced audit-fix): move
`better-auth` + `@better-auth/cli` together to the patched line, regenerate the schema,
**inspect** the migration for a parent-table rebuild, apply local → verify → remote, retest
every auth flow in dev, then deploy. Keep the exact pin.

**Rejected**:
- `npm audit fix --force` — bumps the library without the CLI, without inspecting the
  migration (data-loss risk on D1), and without retesting auth.
- Staying on 1.4.21 indefinitely — leaves a standing critical bundle; acceptable only as the
  short-term state while this is scheduled, given the reachability assessment above.

## Feature design

Sequence (all in local dev first):
1. `npm install better-auth@<v> @better-auth/cli@<v>` (exact), where `<v>` is the current
   patched release; update `package.json` exact pins.
2. `npx @better-auth/cli@<v> generate --config ./better-auth.config.ts --output ./src/server/db/auth-schema.ts -y`.
3. `npx drizzle-kit generate` → **read the new migration SQL**. If it rebuilds `user` or
   `organization`, rewrite it to `ALTER TABLE` (gotcha #9). Otherwise proceed.
4. `wrangler d1 migrations apply aw-file-storage --local` → smoke-test.
5. Run the full auth flow checklist (AC-4) in `next dev`. Fix any breakage from the version
   jump (plugin option renames, hook signature changes).
6. `npm run typecheck && npm test`.
7. Apply the migration `--remote`, then `npm run deploy`. Re-run `npm audit` to confirm AC-5.

Update `AGENTS.md` and `docs/PROGRESS.md` to record the new pinned version and drop the
"pinned to 1.4.21" note.

## Verification

See a future `0023-verify.md` written during implementation. It records: the exact versions
installed, the migration SQL inspection result (rebuild or not, and any hand-edit),
local-dev results for each auth flow in AC-4, the `npm audit` before/after, and the config
re-review (AC-6).

## Out of scope

The `esbuild`/`drizzle-kit` dev-chain moderate advisory (build-only, not in the deployed
Worker; its fix is a destructive `drizzle-kit` downgrade) — accepted separately, tracked in
the spec 0022 dependency pass, revisit when `drizzle-kit` drops the `@esbuild-kit` chain.
