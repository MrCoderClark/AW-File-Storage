# 0001a. Authentication and sessions, on Better Auth

Child of [0001, Secure file storage platform on Cloudflare](index.md).

## Summary

Login is handled by **Better Auth**, a self hosted, open source authentication library, rather than written by hand or bought as a hosted service. Better Auth runs inside our own Worker, keeps every user and session row in our own Cloudflare D1 database, and charges nothing per user. It ships the dangerous primitives already written, reviewed, and attacked by people other than us: password hashing, session issue and revocation, the cross site request forgery defence, rate limiting, email enumeration protection, password reset, email verification, organizations with roles and invitations, and a two factor plugin. This spec's job is therefore no longer to invent those primitives. It is to **configure them correctly for the Cloudflare Workers runtime, and to add the few hardening rules Better Auth does not apply by default**, so that "use a library" becomes "use it the secure way" rather than "accept its defaults and hope".

**Inline rationale.** The umbrella originally chose to write authentication in house and the rationale recorded that a proven library was the better answer. That recommendation has now been taken: this spec supersedes the hand written design. Better Auth over a hosted identity provider (Clerk, WorkOS) because it keeps every user row in our own D1 with no per user fee and no third party holding our staff's credentials; Better Auth over hand rolled because authentication is the one place an ordinary looking mistake is a breach rather than a bug, and a library that other people also attack is worth more than code only we have ever read. The residual risk moves from "did we implement hashing and session rotation correctly" to "did we configure the library correctly", which is a far shorter and far more reviewable list, written out below.

## What Better Auth gives us, and what we add

This split is the whole point of the spec. Do not re-implement the left column.

| Concern | Better Auth default | What this spec does |
|---|---|---|
| Password hashing | scrypt (memory hard), stored with per hash salt | Accept the default. Do **not** swap for a hand written PBKDF2 |
| Session storage | Opaque token in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie; row in D1; instant revocation by deleting the row | Accept, but tighten lifetime and disable long cookie caching so revocation stays near instant (below) |
| CSRF | Origin validation against `trustedOrigins`, Fetch Metadata headers, no mutations on GET | Configure `trustedOrigins` to the one canonical app origin. Never set `disableCSRFCheck` or `disableOriginCheck` |
| Rate limiting | Built in, stricter on auth routes | Point its storage at the database (memory storage does not survive across Worker isolates), and keep the Cloudflare WAF layer in front |
| Email enumeration | Same response whether or not the email exists, when verification is on or auto sign in is off | Turn on `requireEmailVerification`, so this protection is active |
| Password reset / email verification | Single use, expiring tokens; `revokeSessionsOnPasswordReset` | Enable both, wire the send functions to Resend |
| Sign up | Open by default | Set `disableSignUp: true`. Accounts exist only through an organization invitation |
| Two factor | `twoFactor` plugin: TOTP, backup codes, per account lockout | Enable it, require it for privileged roles, encrypt-at-rest via `BETTER_AUTH_SECRET` |
| Organizations, roles, invitations | `organization` plugin: `organization` / `member` / `invitation` tables, roles, active organization on the session | Own the tenancy model in child [0002](0002-tenancy-and-data-model.md), which builds directly on these tables |
| Secret rotation | `BETTER_AUTH_SECRETS` versioned secrets, non destructive | Provision it so the signing/encryption secret can be rotated without downtime |
| Minimum password length | 8 | Raise to 12 |
| Breach check | none | Add the `haveIBeenPwned` plugin (or a before hook calling the HIBP range API), fail open if unreachable |
| Per account escalating lockout | rate limit is per IP/route, not per account | Add a small before hook that counts consecutive failures per account and escalates, on top of the built in limiter |

## Requirements

**User stories**:
- As an invited staff member, I want to set a password and sign in, so that I can use the app.
- As a signed in user, I want my session to survive a page refresh but not last forever, so that a forgotten open laptop is not a permanent door.
- As a user who forgot a password, I want a reset link by email that stops working once used, so that recovery does not become a second way in.
- As an admin, I want to be forced to use an authenticator app, so that the account that can delete everything needs more than a password.
- As an admin, I want to see and end another user's sessions, so that I can cut off access the moment someone leaves.

**Acceptance criteria**:
- **AC-1**: A user with correct credentials receives a session cookie and reaches the dashboard. A user with wrong credentials, a non existent email, or a deactivated account receives the same generic failure, with no hint about which was wrong. This is satisfied by Better Auth's default failure response together with `requireEmailVerification`; the build must not add a code path that distinguishes the cases.
- **AC-2**: A password is stored only as a Better Auth scrypt hash with a per hash salt. No plaintext or reversible form of a password is ever written to the database, to a log, to Sentry, or to a Worker log line. The default hashing is not replaced.
- **AC-3**: The session cookie is `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, and holds an opaque token, not a JSON Web Token and not a user identifier. These are Better Auth defaults over HTTPS and must not be weakened.
- **AC-4**: The session token stored server side cannot be used to reconstruct a live cookie from a database dump alone. Sessions are validated against the D1 row, and a deleted row is immediately unusable.
- **AC-5**: A session has a rolling lifetime of at most 8 hours: `session.expiresIn` is 8 hours and `updateAge` refreshes it on use, so an idle session dies within 8 hours of last activity. An absolute 7 day ceiling from creation is enforced by a session hook that rejects any session older than 7 days regardless of refresh. An expired session is rejected even if its row still exists, and the row is later removed by the nightly cleanup job.
- **AC-6**: Signing out deletes the session row and clears the cookie. Reusing the deleted cookie is rejected. Changing or resetting a password ends every other session belonging to that user (`revokeSessionsOnPasswordReset: true`, and the same on an authenticated password change).
- **AC-7**: Repeated failed sign in attempts are throttled by Better Auth's built in rate limiter (database backed), and a per account lockout hook locks a single account for 15 minutes after 5 consecutive failures, doubling on each further lockout to a maximum of 24 hours; a successful sign in clears the counter. A locked account receives the same generic failure as a wrong password, with no statement that it is locked.
- **AC-8**: Every state changing request is rejected when its `Origin` does not match the configured `trustedOrigins`. This is Better Auth's origin check plus, for our own server actions and routes, one shared middleware check so the guarantee holds for surfaces Better Auth does not itself handle. `disableCSRFCheck` and `disableOriginCheck` are never set.
- **AC-9**: A password reset token is single use and expiring (Better Auth default), is delivered by email through `sendResetPassword`, and completing a reset ends every other session for that user. Requesting a reset returns the same response and takes a comparable time whether or not the address exists.
- **AC-10**: An invitation (organization plugin) expires, works once, and accepting it creates the user and their membership with the role the inviter chose, atomically. There is no open sign up route.
- **AC-11**: A user with an `owner` or `admin` role cannot reach any admin surface until they have enrolled a second factor. A `member` may enrol optionally. Enforcement is a shared server side gate, not a client check.
- **AC-12**: When a second factor is required, a correct password alone grants no full session: Better Auth's `twoFactor` flow yields a pending state that permits nothing except submitting a code, and it expires.
- **AC-13**: A TOTP code works once within its window; a replayed code is rejected. The stored second factor secret and backup codes are encrypted at rest with the key derived from `BETTER_AUTH_SECRET`, so a database dump alone does not yield working secrets. Backup codes are single use.
- **AC-14**: A password shorter than 12 characters is rejected (`minPasswordLength: 12`). A password found in a known breach list is rejected with a message that says so (`haveIBeenPwned` plugin). If the breach check cannot be reached, the password is accepted and the failure is logged (fail open).
- **AC-15**: Every sign in, failed sign in, sign out, password change, reset request, reset completion, invitation, second factor enrolment, and session revocation writes one audit row (through the helper in child [0002](0002-tenancy-and-data-model.md)) recording who, what, when, from which address, and with which user agent. Better Auth's own event hooks are the trigger points.
- **AC-16**: A user sees their own active sessions with device, address, and last used time, and can end any of them (Better Auth `listSessions` / `revokeSession`). An owner or admin can end any session belonging to a user in their own organization, and no session outside it.

## Decision

**Chosen option**: Use Better Auth, self hosted inside our Worker, with its D1 (Drizzle adapter) storage, its `organization` and `twoFactor` plugins, and the `nextCookies` plugin for Next.js server actions. No third party identity service and no hand written cryptography.

This replaces the earlier "write authentication in house" decision recorded in the umbrella. The mitigation is no longer "specify every primitive so we build it right"; it is "configure a proven library right", and the configuration is pinned below.

## Feature design

**Where the config lives.** The D1 binding is only available per request, so the `auth` instance is built per request from the request's `env`, the same shape as the database client in [0002](0002-tenancy-and-data-model.md). A single `src/server/auth.ts` exports `buildAuth(env)`; nothing else constructs an auth instance.

**Server configuration** (the security surface — every line here is a deliberate call):

```ts
// src/server/auth.ts — shape, not final code
betterAuth({
  appName: "AW File Storage",
  database: drizzleAdapter(db, { provider: "sqlite" }), // D1 via Drizzle, see 0002
  secret: env.BETTER_AUTH_SECRET,        // or BETTER_AUTH_SECRETS for rotation
  baseURL: env.APP_URL,
  trustedOrigins: [env.APP_URL],         // the ONLY trusted origin; no wildcards
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,                 // internal only; accounts come from invitations
    minPasswordLength: 12,
    maxPasswordLength: 256,
    requireEmailVerification: true,      // also switches on enumeration protection
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async (...) => {/* Resend */},
    sendVerificationEmail: async (...) => {/* Resend */},
  },
  session: {
    expiresIn: 60 * 60 * 8,              // 8h rolling idle ceiling
    updateAge: 60 * 15,                  // refresh at most every 15 min
    cookieCache: { enabled: false },     // no signed-cookie cache: revocation stays near instant
  },
  rateLimit: {
    enabled: true,
    storage: "database",                 // memory storage does NOT survive across Worker isolates
  },
  plugins: [
    organization({ /* roles owner/admin/member; see 0002 */ }),
    twoFactor({ issuer: "AW File Storage" }),
    haveIBeenPwned({ /* fail open on network error */ }),
    nextCookies(),                       // MUST be last, so server actions can set the cookie
  ],
})
```

**Session lifetime and revocation** (AC-5, AC-6). Better Auth's session model is a rolling expiry: `expiresIn` sets how long a session lives, `updateAge` how often activity extends it. We set `expiresIn` to 8 hours so an idle session dies within 8 hours of last use. Better Auth has no separate absolute ceiling, so we add one: a session validation hook rejects any session whose `createdAt` is more than 7 days ago, no matter how recently it was refreshed. `cookieCache` is left **off**: it would let a revoked session keep working until the cached copy expired, and on an internal tool with a bound D1 the extra read per request is not worth trading instant revocation for.

**Password policy** (AC-14): minimum 12, maximum 256, no composition rules (they push users toward predictable patterns). The `haveIBeenPwned` plugin checks the password against the Pwned Passwords range endpoint using a k-anonymity prefix, so the password never leaves our Worker in full. If that call fails, the password is accepted and the failure is logged.

**Per account lockout** (AC-7). Better Auth's built in rate limiter throttles by IP and route, which blunts a distributed attack but does not by itself lock a single targeted account. A small `before` hook on sign in reads and writes an `account_lock` row: 5 consecutive failures set `locked_until` 15 minutes out, each further lockout doubles the duration to a 24 hour cap, and a success clears the counter. While locked, sign in returns the same generic failure as a wrong password. This runs in addition to, not instead of, the built in limiter and the WAF rules.

**Second factor** (AC-11, AC-12, AC-13). The `twoFactor` plugin provides TOTP (RFC 6238) and single use backup codes, with its own per account lockout on repeated bad codes. Better Auth encrypts the stored TOTP secret and backup codes with a key derived from `BETTER_AUTH_SECRET`, so a database dump alone does not yield working secrets — which is exactly why `BETTER_AUTH_SECRET` must be a strong Worker secret and rotation must be configured. Enrolment shows backup codes once. Requiring the second factor for `owner` and `admin` is a shared server side gate (below), not something the client can skip by navigating.

**Data model.** Better Auth and its plugins own their tables; the schema is generated by the Better Auth CLI and then turned into a checked in migration (see the build plan). Feature code must not redefine these.

| Owner | Tables | Notes |
|---|---|---|
| Better Auth core | `user`, `session`, `account`, `verification` | `user` carries `email` (unique, lowercased), `emailVerified`, `name`, and — from the twoFactor plugin — `twoFactorEnabled`. `session` carries the token hash, `expiresAt`, `ipAddress`, `userAgent`, and `activeOrganizationId` |
| `organization` plugin | `organization`, `member`, `invitation` | `member` holds the role (`owner` / `admin` / `member`). `organization` is extended with the storage fields in [0002](0002-tenancy-and-data-model.md) via `additionalFields`. This replaces the hand written `membership` table |
| `twoFactor` plugin | `twoFactor` | Encrypted secret and backup codes, verified flag, failed attempt and lockout tracking |
| This app | `account_lock`, and the tenant tables in [0002](0002-tenancy-and-data-model.md) | `account_lock` (`user_id` pk, `failed_count`, `locked_until`, `lock_level`) drives AC-7 |

**Interface surface.** Better Auth exposes a mounted handler at `/api/auth/*` for its own flows; our UI calls them through the Better Auth client, and server code reads the caller through `auth.api.getSession`. Only the app specific gates are ours to write.

| Surface | Kind | Provided by | Auth |
|---|---|---|---|
| sign in, sign out, request/complete password reset, verify email | Better Auth routes under `/api/auth/*` | Better Auth core | as appropriate |
| enrol/verify TOTP, submit code, backup codes, list/revoke sessions | Better Auth routes | `twoFactor` plugin, core | session / pending state |
| create/accept invitation, set active organization, list members, change role, remove member | Better Auth routes | `organization` plugin | per role |
| `getSession()` | server helper | wraps `auth.api.getSession(env)` | — |
| `requireOrgRole(role)` | server helper | wraps the session + `member.role`, and enforces the second factor requirement for privileged roles (AC-11) | — |
| `GET /api/auth/get-session` | route | Better Auth | session |

**Key invariants**:
1. `getSession()` and `requireOrgRole(role)` are the only two ways feature code learns who the caller is or gates on a role. Nothing else parses the cookie or reads `member.role`. Children [0003](0003-uploads-and-public-vcard-urls.md) and [0004](0004-upload-center-ui.md) call these, never Better Auth directly for authorization.
2. A response never reveals whether an email address exists, in its body, status code, or timing. `requireEmailVerification` keeps this on.
3. Every token that reaches a user by email or URL is single use and expiring — Better Auth's defaults, not re-implemented.
4. The full session is re-issued through the second factor flow before a privileged action is possible, so a password captured alone is not enough for an admin.
5. Authentication failures may be logged with the attempted email; the attempted password is never logged.
6. Every state changing request passes the origin check before its handler runs.
7. The default scrypt hashing and the default cookie flags are never overridden to something weaker.

**Security model**: internal staff only, so `disableSignUp: true` and there is no public sign up route. Accounts exist only through an organization invitation from an owner or admin. Roles are `owner`, `admin`, and `member` on the `member` table (child 0002). CSRF is defended by `SameSite=Lax`, the origin check against `trustedOrigins`, and Fetch Metadata headers — all Better Auth, plus the one shared middleware check for our own actions. Rate limiting is three layers: Cloudflare WAF rules on the auth routes, Better Auth's database backed limiter, and the per account lockout. Compliance scope: this system holds staff credentials and, through the files it guards, third party personal data, so the audit log in AC-15 is not optional and the second factor requirement on privileged roles is not optional.

**Configuration required** (Worker secrets unless noted):
- `BETTER_AUTH_SECRET` (or `BETTER_AUTH_SECRETS` for rotation): the signing and encryption secret. Encrypts second factor secrets at rest. Must be long and random.
- `APP_URL`: the canonical application origin. Used as `baseURL` and as the sole `trustedOrigins` entry.
- `RESEND_API_KEY`: sends invitation, verification, and reset email.
- `EMAIL_FROM`: the sending address, for example `no-reply@americaworks.com`.
- No `PBKDF2_ITERATIONS`, `TOTP_ENCRYPTION_KEY`, or `SESSION_COOKIE_NAME` are needed any more: Better Auth owns hashing, second factor encryption (via `BETTER_AUTH_SECRET`), and the cookie.

**Critical test scenarios**:
- Happy path: invitation accepted, password set, verified, signed in, dashboard reached, refreshed, signed out. Verifies **AC-1**, **AC-10**, **AC-6**.
- Storage: a created user's stored hash is a Better Auth scrypt hash and the raw password appears nowhere in the database or captured logs. Verifies **AC-2**.
- Cookie: the issued cookie carries `HttpOnly`, `Secure`, `SameSite=Lax`, and decodes to nothing meaningful. Verifies **AC-3**, **AC-4**.
- Lifetime: a session idle past 8 hours is rejected, and a session refreshed repeatedly is still rejected once past 7 days from creation. Verifies **AC-5**.
- Lockout: five wrong passwords lock the account for 15 minutes, the sixth attempt returns the same generic failure as the first, and the tenth lockout does not exceed 24 hours. Verifies **AC-7**.
- Enumeration: sign in and reset request with a known and an unknown email return identical bodies, status codes, and comparable timing. Verifies **AC-1**, **AC-9**.
- CSRF: a state changing `POST` with a foreign `Origin` and a valid cookie is rejected. Verifies **AC-8**.
- Reset: a reset link used once fails the second time and every other session for that user is ended. Verifies **AC-9**, **AC-6**.
- Second factor: an admin with a correct password reaches only the code step, cannot navigate past it to an admin surface, and the pending state expires. Verifies **AC-11**, **AC-12**.
- Replay: the same TOTP code submitted twice inside one window is rejected the second time, and a backup code works once. Verifies **AC-13**.
- Breach check: a known breached password is rejected; with the check made unreachable, the password is accepted and the failure is logged. Verifies **AC-14**.
- Authorisation: an admin in organization A cannot end a session for a user in organization B, receiving a not found rather than the session. Verifies **AC-16**.
- Audit: each recorded event produces exactly one audit row with actor, action, address, and user agent. Verifies **AC-15**.

## Build plan

Thin end to end slices (the assumed default). The point of ordering is to get a real, verified sign in through the real library before layering the hardening on.

1. Install Better Auth and its client, add `src/server/auth.ts` with `buildAuth(env)`, the `drizzleAdapter` over the D1 binding from [0002](0002-tenancy-and-data-model.md), and the base `emailAndPassword` config. Generate the Better Auth schema with its CLI, turn it into a checked in migration, and apply it with `wrangler d1 migrations apply`. Satisfies the storage half of **AC-2**.
2. Thin end to end slice: mount the Better Auth handler at `/api/auth/*`, add `getSession()`, a sign in page against the Better Auth client, and one protected page. Confirm the cookie flags. Satisfies **AC-1**, **AC-2**, **AC-3**, **AC-6** (sign out).
3. The shared origin check middleware for our own actions and routes, and route protection redirecting an anonymous caller to sign in. Confirm `trustedOrigins`. Satisfies **AC-8**.
4. Session lifetime: `expiresIn` 8h, `updateAge`, `cookieCache` off, and the 7 day absolute ceiling hook, plus the nightly Cron cleanup of expired rows. Satisfies **AC-5**.
5. Rate limiting to database storage, the WAF rules, and the per account `account_lock` hook with its doubling. Satisfies **AC-7**.
6. Password policy (`minPasswordLength: 12`) and the `haveIBeenPwned` plugin with a fail open path. Satisfies **AC-14**.
7. Resend wiring for `sendResetPassword` and `sendVerificationEmail`, `requireEmailVerification`, and `revokeSessionsOnPasswordReset`. Satisfies **AC-9**, the enumeration half of **AC-1**, and the rest of **AC-6**.
8. Organization plugin: invitations, accept flow, active organization on the session, and the `member` role source of truth (the tenancy detail lives in [0002](0002-tenancy-and-data-model.md)). Satisfies **AC-10**.
9. `twoFactor` plugin: enrolment, backup codes, the pending flow, and `requireOrgRole` enforcing it for `owner` and `admin`. Satisfies **AC-11**, **AC-12**, **AC-13**.
10. Audit writes on all sixteen event types, through the helper from [0002](0002-tenancy-and-data-model.md), triggered from Better Auth's event hooks. Satisfies **AC-15**.
11. Session management screen: `listSessions`, `revokeSession`, and the admin view scoped to the organization. Satisfies **AC-16**.
12. The test suite from Critical test scenarios, in Vitest against real D1 bindings plus Playwright for the browser flows. Covers every acceptance criterion above.
