# 0011. Harden the Office 365 integration: certificate auth + least privilege

**Date**: 2026-09-02

## Summary

The Office 365 sync (spec 0010) currently signs in to Microsoft Graph with a shared **client secret**, and its app registration holds the **tenant wide** `User.ReadWrite.All` permission, so a leaked secret could edit every user in the tenant. This spec closes both gaps. First, swap the secret for a **certificate**: the app signs a short lived token request with a private key it holds, so there is no shared secret to leak or to expire. Second, replace the tenant wide permission with a **custom role scoped to an Administrative Unit** (a group of just the staff accounts), so the app can only touch users inside that unit. Same write ability (still needed to set `CustomAttribute1`), far smaller blast radius. Rolled out the safe way: add the certificate alongside the secret, verify, then remove the secret and downgrade the permission.

## Context

Spec 0010 authenticates to Graph app only (client credentials) using `GRAPH_CLIENT_SECRET`, and the Entra app `Office 365 VCard - awvcard.com` was consented for the application permission `User.ReadWrite.All`. That combination carries the integration's real residual risk (noted in 0010's follow ups):

- **The secret is a bearer credential.** It is stored correctly (a Worker secret, never in code, the client, the DB, or git), but a shared secret can still leak, and it **expires**, which caused a real outage on an earlier AW app when a rotation was missed.
- **`User.ReadWrite.All` is tenant wide.** Microsoft Graph application permissions are granted per **resource type** (user), never per **property**, so there is no way to grant "write only `extensionAttribute1`". `User.ReadWrite.All` is the least privileged Graph app permission that can write extension attributes at all. It cannot reset passwords, disable accounts, or grant roles (those need privileged directory roles the app lacks), but it can modify profile fields on **every** user in the tenant. A leaked secret therefore reaches the whole directory.

The write the app performs is itself low value (a public card URL), so the exposure is the **credential plus its reach**, not the data written. Two levers close it: a certificate removes the shared secret and the expiry outage, and an Administrative Unit narrows which users the app can write. The runtime is Cloudflare Workers, so all signing must use Web Crypto (`crypto.subtle`); there is no Node `crypto`.

## Requirements

**User stories**:
- As the operator, I want the Graph integration to authenticate with a certificate, so there is no shared secret to leak or let expire.
- As the operator, I want the app to be able to write attributes only for a defined set of staff accounts, not every user in the tenant, so a credential compromise has a small blast radius.
- As the operator, I want to switch to the certificate and the scoped permission without an outage, and to be able to roll back at each step.

**Acceptance criteria**:
- **AC-1**: When the certificate secrets (`GRAPH_CLIENT_CERT_PRIVATE_KEY` + `GRAPH_CLIENT_CERT_THUMBPRINT`) are set, the Graph token is obtained with a **signed JWT client assertion** (RS256, signed via `crypto.subtle`), and the sync works exactly as before.
- **AC-2**: If the certificate secrets are absent but `GRAPH_CLIENT_SECRET` is set, the app still uses the existing client-secret flow (transition support), so a deploy before the cert is in place does not break the sync.
- **AC-3**: `graphConfigured()` returns true when **either** a certificate **or** a client secret is configured, so the rest of spec 0010 (the toggle, the gates) is unchanged.
- **AC-4**: After the Entra change, the app's directory access is via a **custom role scoped to an Administrative Unit**, and the tenant wide `User.ReadWrite.All` application permission is **removed**. A PATCH to a user **inside** the AU succeeds; a user **outside** the AU cannot be written (Graph denies it).
- **AC-5**: No private key or client secret ever appears in code, the client bundle, the database, git, or a response. The private key is a Worker secret used only server side for signing; it is never sent anywhere.
- **AC-6**: Each rollout step is reversible: the certificate runs alongside the secret before the secret is removed, and the AU-scoped role can be swapped back to the app permission if the scoped write fails.

## Options considered

### Option 1: Certificate auth + Administrative-Unit-scoped custom role (chosen)

Replace the secret with a certificate client assertion, and replace the tenant wide app permission with a custom directory role scoped to an AU. Roll out strangler style (both in place, verify, then remove the old).

**Pros**:
- Closes both risks: no shared secret (and no expiry outage), and the app can write only users in the AU.
- No new dependency (Web Crypto is built in); no data model change.

**Cons**:
- More Entra setup (an AU, a custom role, a scoped assignment) and certificate lifecycle to run.
- Certificates still expire (longer lived, and no silent partial failure), so rotation is still a task, just rarer.

### Option 2: Certificate auth only, keep `User.ReadWrite.All`

Swap the secret for a certificate but leave the tenant wide permission.

**Pros**:
- Simplest; removes the shared-secret and expiry risk with a code change only.

**Cons**:
- Leaves the tenant wide reach: a compromised private key still edits every user. Half the risk remains, so rejected as the end state (its cert work is reused by Option 1).

### Option 3: Keep the secret, add only the AU-scoped role

Narrow the permission but keep the client secret.

**Pros**:
- Smaller blast radius with no code change.

**Cons**:
- The shared secret and its expiry outage remain. Rejected as the end state; its Entra work is reused by Option 1.

## Decision

**Chosen option**: Option 1: certificate client-assertion auth in `graph.ts`, plus an Administrative-Unit-scoped custom role in Entra replacing `User.ReadWrite.All`, rolled out strangler style.

**Implementation skills**: `msgraph` (`.agents/skills/msgraph/` or the project skills dir) — verify the exact Entra custom-role action for writing cloud extension attributes and the client-assertion token shape.

## Rationale

The residual risk in spec 0010 is the credential and its reach, so both levers are pulled. A certificate is strictly better than a secret for a daemon: nothing shared to leak, the private key never leaves our Worker, and it removes the silent expiry outage that already bit an AW app. Since Graph permissions cannot be narrowed to one property (a hard Microsoft constraint, not a project choice), the only way to shrink reach is to shrink the **set of users**, which an Administrative Unit plus a custom role does cleanly: same user-update capability the sync needs, but only inside the unit. Options 2 and 3 each fix one half and were rejected as end states, though their work is exactly the two halves of Option 1. The strangler rollout (certificate alongside the secret, verify, then remove the secret and downgrade the permission) is required because this is a live integration writing real mailboxes; a hard swap risks an outage with no fallback.

## Feature design

**Data model sketch**: no change.

**Token acquisition** (`src/server/graph.ts`, replacing the `client_secret` body):
- Build a JWT **client assertion**:
  - Header: `{ "alg": "RS256", "typ": "JWT", "x5t": <base64url SHA-1 thumbprint of the cert> }`.
  - Payload: `{ "aud": "https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token", "iss": <client_id>, "sub": <client_id>, "jti": <uuid>, "iat": now, "nbf": now, "exp": now + 300 }`.
  - Sign `base64url(header) + "." + base64url(payload)` with the private key: `crypto.subtle.importKey("pkcs8", <DER from the PEM>, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"])` then `sign` → base64url signature.
- POST to the token endpoint with `client_id`, `client_assertion=<jwt>`, `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`, `scope=https://graph.microsoft.com/.default`, `grant_type=client_credentials`.
- **Selection**: use the certificate when `GRAPH_CLIENT_CERT_PRIVATE_KEY` + `GRAPH_CLIENT_CERT_THUMBPRINT` are set; otherwise fall back to the existing `client_secret` flow. Token caching (module scope) is unchanged.

**Entra configuration** (operator steps, no app code — the second half of the decision):
1. Create an **Administrative Unit** (e.g. "AW Staff Cards") and add the staff user accounts to it.
2. Create a **custom directory role** whose only permission is the user-update action that covers cloud extension attributes (confirm the exact action in the role builder; `microsoft.directory/users/extensionAttributesForCloudUsers/update` is the candidate for cloud-only extension attributes, else the basic-profile update action).
3. Assign that custom role to the app's **service principal**, **scoped to the AU**.
4. Once the scoped write is verified, **remove** the `User.ReadWrite.All` application permission from the app registration (and revoke its admin consent).

**Certificate generation** (documented in verify/rollout; self-signed is fine for app auth):
- `openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 730 -nodes -subj "/CN=aw-file-storage-graph"`
- Private key as PKCS8 PEM for the Worker secret: `openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pk8.pem`
- SHA-1 thumbprint for `x5t` (Entra shows this on upload): `openssl x509 -in cert.pem -fingerprint -sha1 -noout` → hex; the header value is the **base64url of the raw SHA-1 bytes** (not the hex string).
- Upload `cert.pem` (public) to the app registration under Certificates & secrets.

**Key invariants**:
- The private key is only ever read from a Worker secret and used to sign; it is never logged, returned, or written to the DB.
- The token flow prefers the certificate and falls back to the secret; both produce an identical Graph token, so nothing downstream changes.
- After the Entra change, a write outside the AU fails; the app depends on AU membership for reach.

**Security model**:
- App-only Graph access, now via a certificate (asymmetric, no shared secret). The private key lives only as a Worker secret; the public certificate is on the app registration.
- Directory write is limited to the AU by a custom role, so a compromised private key can modify only users in that unit, and only their attributes (still not passwords/roles/enablement).
- Residual risk after this spec: a leaked private key reaches **only the AU's users**, a large reduction from tenant wide.

**Configuration required**:
- New Worker secrets: `GRAPH_CLIENT_CERT_PRIVATE_KEY` (PKCS8 PEM) and `GRAPH_CLIENT_CERT_THUMBPRINT` (base64url SHA-1 thumbprint for `x5t`).
- `GRAPH_CLIENT_SECRET` stays during transition, then is **removed** after the certificate is verified.
- `GRAPH_TENANT_ID` / `GRAPH_CLIENT_ID` unchanged.

**Critical test scenarios** (each maps to an acceptance criterion):
- Cert path: with the cert secrets set, a token is acquired and a card sync writes `CustomAttribute1` for an in-AU user. Verifies **AC-1**.
- Fallback: with the cert secrets absent but the client secret present, the sync still works. Verifies **AC-2, AC-3**.
- Scope enforced: a PATCH to a user **in** the AU succeeds; a PATCH to a user **outside** the AU is denied by Graph. Verifies **AC-4**.
- Secret hygiene: grep the bundle/DB/logs for the private key/secret finds nothing; the key is only in Worker secrets. Verifies **AC-5**.

## Migration plan

**Strategy**: strangler (both credentials, then both permission models, side by side; verify, then retire the old).

**Phases**:
1. Ship the code that prefers the certificate and falls back to the secret (`graphConfigured` accepts either). Deploy with only the secret still set: no behavior change.
2. Generate the certificate, upload the public cert to the app registration, set `GRAPH_CLIENT_CERT_PRIVATE_KEY` + `GRAPH_CLIENT_CERT_THUMBPRINT`. The app now signs in with the cert; verify a card sync still writes `CustomAttribute1`.
3. Create the Administrative Unit, custom role, and scoped assignment. Verify a write to an in-AU user succeeds.
4. Remove the tenant wide `User.ReadWrite.All` app permission (revoke consent). Verify the sync still works for in-AU users and is denied for an out-of-AU user.
5. Remove `GRAPH_CLIENT_SECRET` from the Worker secrets and delete the secret in the app registration.

**Rollback**: at phase 2, unset the cert secrets → the app falls back to the secret. At phases 3 to 4, re-add the `User.ReadWrite.All` app permission (and consent) if the scoped write fails, before removing the secret. Do not remove the secret (phase 5) until the certificate and the scoped role are both proven.

**Risks**: a wrong `x5t` thumbprint encoding (must be base64url of the raw SHA-1 bytes, not the hex) → token request fails (caught in phase 2, secret still present); the custom-role action not actually covering extension attributes → writes 403 in phase 3 (roll back the permission); certificate expiry (set a calendar reminder; longer lived than a secret but not forever).

## Build plan

Strangler order: land the cert-capable code first (safe, no behavior change), then the operator does the Entra/cert steps per the migration plan.

1. In `src/server/graph.ts`: add certificate client-assertion token acquisition (JWT build + `crypto.subtle` RS256 signing + PKCS8 PEM import), select cert over secret when its secrets are present, keep the secret path as fallback. Satisfies **AC-1, AC-2, AC-5**.
2. Update `graphConfigured()` to return true when a certificate **or** a secret is configured. Satisfies **AC-3**.
3. Tests: JWT assertion is well formed (header `x5t`, payload `aud`/`iss`/`sub`/`exp`), and the cert path is chosen over the secret when both are present (signing/crypto mocked or a test key). Satisfies **AC-1, AC-2**.
4. Config + docs: record the new secrets and the operator runbook (cert generation, Entra AU + custom role + scoped assignment, permission removal) in the verify doc. Satisfies **AC-4, AC-6** (operator-executed, code-independent).

## Consequences

**Positive**:
- No shared secret to leak, and no silent expiry outage; the private key never leaves the Worker.
- A compromised credential can write only the AU's users, not the whole tenant.
- No new dependency, no data model change; the rest of spec 0010 is untouched (same token downstream).

**Negative / tradeoffs**:
- More Entra moving parts to set up and understand (AU, custom role, scoped assignment) and to keep correct as staff change (AU membership).
- Certificates still expire; rotation remains a (rarer) task.
- The client-assertion signing is more code than posting a secret, and must be right (thumbprint encoding, PKCS8 import) for the token to be issued.

**Neutral**:
- `graphConfigured` now accepts two credential shapes; the toggle and gates in spec 0010 are unchanged.
- AU membership becomes the thing that governs reach, so onboarding a new staff card assumes the person is in the AU.

## Follow-up

- [ ] Automate or calendar the certificate rotation before expiry (e.g. a 2-year cert with a reminder), and decide whether to script re-issue.
- [ ] Keep AU membership in step with staff changes (or, later, drive the AU from the same Entra provisioning that a future "provision cards from Entra ID" feature would use).
- [ ] Confirm the exact custom-role action name in the Entra role builder during phase 3, and record it here.
