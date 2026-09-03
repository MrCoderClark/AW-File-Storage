# Verify: Per-org Office 365 connections · spec 0013 · 2026-09-03
_Steps derived from spec 0013 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## Code
- [ ] `npx vitest run test/secret-box.test.ts` → encrypt→decrypt round-trips; a wrong KEK fails to decrypt → AC-2
- [ ] `npx vitest run test/graph.test.ts` → `graphConfiguredForOrg` gate + a token is requested from `creds.tenantId`'s endpoint with `creds.clientId` (mock fetch) → AC-1, AC-4
- [ ] `npx vitest run test/o365-sync.test.ts` → two orgs with different creds each sync against their OWN tenant; an org with no creds no-ops → AC-1, AC-4, AC-7
- [ ] `npx vitest run test/isolation.test.ts` → `orgDb("").graphCreds` throws; org A cannot read org B's creds → AC-3
- [ ] Secret hygiene: the `/api/settings/o365` GET response never contains a secret/key; `npx opennextjs-cloudflare build` then grep the bundle finds none → AC-2

## Config
- [ ] Set `O365_CRED_KEK` (base64 AES-256): `npx wrangler secret put O365_CRED_KEK` (generate e.g. `openssl rand -base64 32`) → AC-2

## Migration
- [ ] Generated migration is **additive**: creates `org_o365`, does NOT `DROP TABLE organization` (cat the SQL — gotcha #9) → AC-2
- [ ] Apply: `npx wrangler d1 migrations apply aw-file-storage --local` then `--remote`

## Operator runbook — strangler cutover (DONE 2026-09-03)

### Phase 1 — deploy per-org-capable code (globals still present, unused)
- [x] Merge + set `O365_CRED_KEK` (`openssl rand -base64 32`, once, platform-wide) + `npm run deploy`. The new code reads per-org creds; the global `GRAPH_*` remained set but unused.

### Phase 2 — each org enters its own credentials
- [x] America Works: Settings → Office 365 → entered AW's tenant id, client id + **certificate** → **Save & test** → connected; a reconcile synced **110 cards, 0 errors** in AW's tenant. → AC-1, AC-5
- [ ] Each other org (a different company) enters ITS OWN Entra app credentials (see the connection guide below) → Save & test → connected; its cards sync into ITS tenant, and it sees no mention of AW. → AC-1, AC-6
- [ ] Rollback: **Disconnect** clears an org's row → that org's sync no-ops. → AC-4

### Phase 3 — retire the global vars
- [x] AW proven on its own row, so the global secrets were deleted:
  `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `GRAPH_CLIENT_CERT_PRIVATE_KEY`, `GRAPH_CLIENT_CERT_THUMBPRINT`. Nothing platform-level names a Microsoft tenant now. → AC-6

## Connecting an organization's Office 365 (per-org guide)

**Platform prerequisite (once):** `O365_CRED_KEK` is set as a Worker secret
(`npx wrangler secret put O365_CRED_KEK`, value = `openssl rand -base64 32`). It is a
**critical, permanent secret** — never regenerate it, or every org's stored credentials
become undecryptable. Back it up.

**In the org's OWN Microsoft tenant** — an Entra **app registration** with the application
permission **`User.ReadWrite.All`** + **admin consent** (needed to write
`onPremisesExtensionAttributes.extensionAttribute1`). From that app's **Overview** page,
copy the **Directory (tenant) ID** and **Application (client) ID** (both non-secret GUIDs;
*not* the Object ID).

**Then in the app** — Settings → Office 365 → Connection → enter tenant id + client id, pick
an auth method, and **Save & test** (verifies against the org's tenant before storing):

- **Client secret (simplest):** app → Certificates & secrets → **New client secret** → copy
  the **Value** (shown once) → paste into the Client secret field.
- **Certificate (no expiry-outage risk):** generate one and upload the public half to the
  app (Certificates & secrets → Certificates → Upload `cert.pem`):
  ```bash
  openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 730 -nodes -subj "/CN=<org>-graph"
  openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pk8.pem   # PKCS8 private key
  openssl x509 -in cert.pem -fingerprint -sha1 -noout          # the thumbprint
  ```
  Then in the form: paste the **full contents of `key.pk8.pem`** (including the
  `-----BEGIN PRIVATE KEY-----` / `-----END PRIVATE KEY-----` lines) into the private-key
  field, and the **thumbprint as hex only** into the thumbprint field.
  - **Gotcha 1 — PKCS8:** use `key.pk8.pem` (starts `-----BEGIN PRIVATE KEY-----`), NOT
    `key.pem` (`-----BEGIN RSA PRIVATE KEY-----`) — the import expects PKCS8.
  - **Gotcha 2 — thumbprint is hex only:** paste just the `AB:CD:…` hex (colons OK); do
    NOT include the `SHA1 Fingerprint=` prefix, or the token request 401s.

The secret / private key is **encrypted at rest** (AES-GCM with `O365_CRED_KEK`) and is
**never shown again** — to change it, re-enter it via **Update credentials**. **Disconnect**
clears the row. Enter/rotate the org's credentials before the cert/secret expires (a cert
here is ~2 years); Save & test surfaces a break.

## How connections are stored (security)

Each org's Office 365 connection lives in the **`org_o365`** table in the Cloudflare
**D1** database, one row per org, reached only through the org-scoped wrapper
(`orgDb().graphCreds`) so one org can never read another's.

- **Not secret → plaintext:** `tenant_id`, `client_id`, `auth_method`, `cert_thumbprint`.
  These identify the app but grant nothing on their own.
- **Secret material → encrypted:** the **client secret** or the **certificate private
  key** is encrypted with **AES-256-GCM** (Web Crypto) before it is written; the row holds
  only the ciphertext (`secret_ct` / `cert_key_ct`) and a random per-value IV
  (`secret_iv` / `cert_key_iv`). The plaintext is **never** stored.
- **The encryption key (`O365_CRED_KEK`) is a Cloudflare Worker secret** — held in
  Cloudflare's secret store, **never in the database, the code, the client bundle, or git**.
- **Decryption is server-side and transient:** the plaintext exists only briefly in Worker
  memory during a sync or a Save-and-test, then is discarded. It is never returned to the
  browser (the GET endpoint omits it), logged, or written to disk in the clear.
- **Defence in depth:** a database leak *without* the KEK is useless ciphertext; the KEK
  *without* the database has nothing to decrypt. Both are required to recover a secret.

Because the sync runs server-side (a background job writing into each org's tenant), the
platform necessarily custodies these encrypted credentials — an intentional trade-off (the
only design that avoids storing them, a shared multi-tenant connector app, would reveal the
publisher to every org and was rejected). Customers can shrink the blast radius on their
side by scoping their Entra app to an Administrative Unit (least privilege).

## Hygiene
- [ ] The per-org secret/key appears only as ciphertext in D1 — never in a response, the client bundle, git, or logs. → AC-2
- [ ] `O365_CRED_KEK` is a critical secret: losing it makes every stored credential undecryptable (rotation = re-enter creds). Record it safely.

## Acceptance-criteria coverage
- AC-1 per-org creds, own tenant · AC-2 encrypted at rest, never leaked · AC-3 reached only via orgDb().graphCreds · AC-4 per-org connected gate + no-op without creds · AC-5 save-and-test · AC-6 global GRAPH_* removed, AW just an org · AC-7 many orgs per reconcile, caches keyed per tenant
