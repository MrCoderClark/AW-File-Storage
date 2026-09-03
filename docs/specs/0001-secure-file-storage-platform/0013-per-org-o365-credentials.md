# 0013. Per-organization Office 365 connections (each org brings its own Entra app)

**Date**: 2026-09-03

## Summary

The Office 365 sync (specs 0010/0011) authenticates with **one global set of Worker secrets** (`GRAPH_TENANT_ID` / `GRAPH_CLIENT_ID` / `GRAPH_CLIENT_SECRET` / cert), tying the entire platform to a single Microsoft 365 tenant (America Works'). But every organization in this app is a **separate company with its own M365 tenant**, and America Works is just one org among them — it must not be special, global, or visible to any other org. Worker env holds one value for the whole platform, so the credentials cannot live there. This spec makes each org bring **its own Entra app** — its tenant id, client id, and a client **secret or certificate** — entered and tested from that org's own Settings and stored **encrypted per-org** in the database. The platform keeps no org's Microsoft identity; the only platform secret is a generic encryption key. The sync then authenticates each card against **its own org's tenant**, so one org can never reach another's directory, and no org learns of America Works' existence. Spec 0012's per-org sync **toggle** stays as the on/off switch layered under the per-org connection.

## Context

Spec 0010 built the sync against Worker-level `GRAPH_*` secrets; spec 0011 added certificate auth (still one global credential); spec 0012 made the sync **toggle** per-org but left the credentials global. That last gap is the blocker for real multi-tenancy: with one shared credential, a non-AW org turning the toggle on would write into **AW's** tenant and match emails against **AW's** directory — wrong and a cross-tenant leak. The runtime is Cloudflare Workers (Web Crypto only; no Node `crypto`), and D1 has **no encryption at rest**, so any secret stored there must be encrypted by the application. The existing `graph.ts` already does all signing via `crypto.subtle` (spec 0011), which this spec reuses.

## Requirements

**User stories**:
- As an org admin, I want to connect **my** company's Microsoft 365 by entering my own Entra app's credentials, so my cards sync into **my** tenant.
- As an org admin, I never want to see, depend on, or learn about any other org's Microsoft setup (including America Works').
- As the operator, I want each org's secret held **encrypted**, never in the client, a response, logs, or git.
- As the operator, I want to confirm a credential works **when it is saved**, not discover it at 3am.

**Acceptance criteria**:
- **AC-1**: An org's O365 credentials (tenant id, client id, and a secret **or** certificate) are stored **per-org** and used **only** for that org's sync. A card is synced against **its own org's** tenant; no credential or token is ever shared across orgs.
- **AC-2**: The secret / certificate private key is **encrypted at rest** (AES-GCM via Web Crypto, key = the `O365_CRED_KEK` Worker secret), never returned in any response, and never present in the client bundle, logs, or git. Tenant id, client id, and cert thumbprint are not secret and may be stored plaintext.
- **AC-3**: Credentials are reached **only** through the org-scoped wrapper (`orgDb().graphCreds`), so one org can never read another's; a call with no org in scope throws `OrgScopeError`.
- **AC-4**: An org counts as **connected** when it has a tenant id, client id, and a secret or certificate. `graphConfiguredForOrg` gates the feature per-org; the spec-0012 toggle switches it. The sync is a **no-op** for an org with no credentials.
- **AC-5**: **Save-and-test** performs a real token acquisition (plus a trivial Graph read) against the org's tenant and reports success or the failure reason; an invalid credential is rejected at save time and not left as the active connection.
- **AC-6**: The global `GRAPH_*` Worker secrets are **removed**; nothing platform-level ties to a specific Microsoft tenant (only the generic `O365_CRED_KEK` remains). America Works is an ordinary org whose credentials happen to be configured.
- **AC-7**: The nightly reconcile syncs each connected, enabled org against **its own** credentials; many orgs coexist in one run (token/signing caches keyed per tenant+client, not one global token).

## Decision

**Chosen approach**: per-org Entra credentials, entered/tested in Settings, stored in a new additive `org_o365` table behind `orgDb().graphCreds`, with the secret/cert-key encrypted by a platform `O365_CRED_KEK` via AES-GCM. `graph.ts` is refactored to take a decrypted `GraphCreds` object (instead of `GraphEnv`) with per-tenant caches; `o365-sync.ts` loads each card's org credentials at sync time. The global `GRAPH_*` vars are retired.

**Rejected — a shared multi-tenant connector app + admin consent**: the standard SaaS pattern, but it registers one app in *our* directory that every customer consents to, which surfaces the publisher (America Works) to every org — a hard "no" for this product. Each org bringing its own app keeps every org fully blind to the others.

**Rejected — Cloudflare per-secret bindings**: Worker bindings/vars are static and one-per-platform; they cannot be keyed per org at runtime.

## Feature design

**Data model** — new additive table `org_o365` (create-only migration; `organization` is never rebuilt, gotcha #9). One row per configured org, `org_id` PK/FK→organization (cascade):

| Column | Secret? | Notes |
|---|---|---|
| `org_id` | — | PK/FK |
| `tenant_id`, `client_id` | no | plaintext |
| `auth_method` | no | `'secret'` \| `'certificate'` |
| `secret_ct`, `secret_iv` | **yes** | AES-GCM of the client secret (null if cert) |
| `cert_key_ct`, `cert_key_iv` | **yes** | AES-GCM of the PKCS8 private key (null if secret) |
| `cert_thumbprint` | no | plaintext SHA-1 (if cert) |
| `last_verified_at`, `updated_at` | — | |

**Crypto** (`src/server/secret-box.ts`, new): `encryptSecret(kek, plaintext) → { iv, ct }` and `decryptSecret(kek, iv, ct)` using `crypto.subtle` AES-GCM with a random 12-byte IV per value; the KEK is imported from the base64 `O365_CRED_KEK` Worker secret. Reuses the b64/Web-Crypto idioms already in `graph.ts`.

**Wrapper** (`src/server/org-db.ts`): add `graphCreds` — `get()` (row or undefined), `set(row)`, `clear()` — org-scoped like every other helper (AC-3). It stores/returns the **encrypted** fields; encrypt/decrypt happens in the O365 layer, so the KEK never enters the wrapper.

**Graph** (`src/server/graph.ts`): a decrypted `GraphCreds { tenantId, clientId, method, secret?, certPrivateKey?, certThumbprint? }`. `getToken(creds)` puts `creds.tenantId` in the token endpoint and uses `creds.clientId` + the secret or cert assertion. The single module `tokenCache`/`signingKeyCache` become **Maps keyed by `tenantId:clientId`** (AC-7). `graphConfiguredForOrg(creds)` replaces `graphConfigured(env)`. `findUsersByEmail` / `patchUserExtensionAttribute1` / `buildClientAssertion` take `creds`. The `GRAPH_*` env fields are removed.

**Sync** (`src/server/o365-sync.ts`): a small `loadGraphCreds(env, orgId)` reads `orgDb(orgId).graphCreds.get()`, decrypts with the KEK, returns `GraphCreds | null`. `syncCardToO365` loads the card's org creds → null or toggle off ⇒ skip; else sync with those creds. `reconcileO365` loads creds per org (cache per run) and syncs each connected+enabled org against its own tenant.

**UI** (`src/components/o365-settings-section.tsx` + `/api/settings/o365`): add a **credentials form** — tenant id, client id, auth method, and a secret **or** cert private key + thumbprint. **Save & test** encrypts + stores + does a live token/Graph check and shows connected / error. Secret and key are **write-only** (never returned; the GET shows only "configured / last verified" + the non-secret ids). **Disconnect** clears the row. The existing per-org toggle, status summary, and "Sync all now" stay, now requiring credentials.

**Key invariants**:
- A card is synced only with its **own org's** credentials; tokens are cached per tenant+client and never shared.
- The KEK lives only as a Worker secret; per-org secrets are ciphertext in D1, decrypted server-side only at sync/test, and never leave the server.
- Nothing platform-level names a Microsoft tenant after this spec; AW is one row like any other.

**Security model**: each org's app permission (`User.ReadWrite.All`, or a customer-chosen AU-scoped role) is granted **in that org's own tenant** by that org's admin — the app never crosses tenants. Compromise of one org's stored secret reaches only that org's tenant, and only if the KEK is also compromised (defence in depth). Residual: the platform holds customers' encrypted secrets (a new custodial responsibility) — mitigated by encryption + the KEK never touching D1.

**Configuration required**: new Worker secret `O365_CRED_KEK` (base64 AES-256 key). Removed: `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `GRAPH_CLIENT_CERT_PRIVATE_KEY`, `GRAPH_CLIENT_CERT_THUMBPRINT`.

**Critical test scenarios**:
- Round-trip: `decryptSecret(encryptSecret(x)) === x`; a wrong KEK fails to decrypt. Verifies **AC-2**.
- Per-org tokens: two orgs with different creds each acquire a token from **their own** tenant endpoint (mock `fetch`, assert URL + body); no token is reused across them. Verifies **AC-1, AC-7**.
- Gate: `graphConfiguredForOrg` true only with tenant+client+(secret|cert); the sync no-ops for an org with no creds. Verifies **AC-4**.
- Scope: `orgDb("").graphCreds` throws; org A cannot read org B's creds. Verifies **AC-3**.
- Hygiene: the GET response and client bundle never contain a secret/key; grep finds none. Verifies **AC-2**.

## Migration plan

**Strategy**: additive table + a strangler cutover for the credential source.

**Phases**:
1. Ship `org_o365` + `secret-box.ts` + the per-org `graph.ts`/`o365-sync.ts` + the Settings UI. Deploy with `O365_CRED_KEK` set; the global `GRAPH_*` still present but **unused** by the new code path.
2. Each org (America Works first) enters its own credentials via Settings → Save & test → connected. Verify a card sync writes CustomAttribute1 in that org's tenant.
3. Once AW (and any other org) is verified on its own credentials, **remove** the global `GRAPH_*` Worker secrets.

**Rollback**: at phase 2, Disconnect clears an org's row (its sync no-ops). Do **not** remove the global `GRAPH_*` (phase 3) until AW is proven on its own row, so there is always a working path.

**Risks**: a lost/rotated `O365_CRED_KEK` makes every stored secret undecryptable (document it as a critical secret; rotation = re-enter creds); a wrong per-org credential (caught by Save-and-test at entry); forgetting to migrate AW before deleting the globals (phase ordering prevents the outage).

## Build plan

1. `org_o365` table + additive migration; `secret-box.ts` (AES-GCM). Satisfies **AC-2** (storage).
2. `orgDb().graphCreds` get/set/clear. Satisfies **AC-3**.
3. `graph.ts`: `GraphCreds`, per-tenant caches, `getToken(creds)`, `graphConfiguredForOrg`, creds-taking Graph calls. Satisfies **AC-1, AC-7**.
4. `o365-sync.ts`: `loadGraphCreds` + per-org sync/reconcile. Satisfies **AC-1, AC-4**.
5. Settings route + UI: save/test/disconnect, write-only secrets. Satisfies **AC-5**.
6. Config/docs: `O365_CRED_KEK`, retire `GRAPH_*` (verify doc runbook). Satisfies **AC-6**.
7. Tests per Critical test scenarios.

## Consequences

**Positive**:
- Genuine per-tenant O365: each org syncs into its own directory; no org sees another (or America Works).
- No platform-level Microsoft identity; AW is demoted to an ordinary org.
- Reuses spec 0011's cert code and spec 0012's per-org wrapper + toggle.

**Negative / tradeoffs**:
- The platform now custodies customers' secrets (encrypted) — a real responsibility and the `O365_CRED_KEK` becomes a critical secret.
- More onboarding per org (each registers its own Entra app and enters credentials).
- Certificates/secrets still expire per org; rotation is each org's task (Save-and-test surfaces a break).

**Neutral**:
- The spec-0012 toggle now reads as "is *this* connected org's sync on."
- `graph.ts` grows per-tenant caches; downstream Graph behaviour is otherwise unchanged.

## Follow-up

- [ ] Per-org credential-expiry reminders (secret/cert), surfaced in Settings.
- [ ] Optional `O365_CRED_KEK` rotation runbook (re-encrypt all rows).
- [ ] Revisit whether to offer the AU-scoped custom role (spec 0011 phases 3–5) as guidance to customers configuring their own app.
