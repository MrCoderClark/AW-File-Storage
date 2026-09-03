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

## Operator runbook — strangler cutover (reversible)

### Phase 1 — deploy per-org-capable code (globals still present, unused)
- [ ] Merge + set `O365_CRED_KEK` + `npm run deploy`. The new code reads per-org creds; the global `GRAPH_*` remain set but are no longer used by the sync.

### Phase 2 — each org enters its own credentials
- [ ] America Works first: Settings → Office 365 → enter AW's tenant id, client id, and secret **or** certificate → **Save & test** → connected. Verify a card sync writes CustomAttribute1 in AW's tenant. → AC-1, AC-5
- [ ] Each other org (a different company) enters ITS OWN Entra app credentials → Save & test → connected. Confirm its cards sync into ITS tenant, and it sees no mention of AW. → AC-1, AC-6
- [ ] Rollback: **Disconnect** clears an org's row → that org's sync no-ops. → AC-4

### Phase 3 — retire the global vars
- [ ] Only after AW is proven on its own row: delete the global secrets —
  `npx wrangler secret delete GRAPH_TENANT_ID` (and `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `GRAPH_CLIENT_CERT_PRIVATE_KEY`, `GRAPH_CLIENT_CERT_THUMBPRINT`). Nothing platform-level names a tenant afterward. → AC-6

## Hygiene
- [ ] The per-org secret/key appears only as ciphertext in D1 — never in a response, the client bundle, git, or logs. → AC-2
- [ ] `O365_CRED_KEK` is a critical secret: losing it makes every stored credential undecryptable (rotation = re-enter creds). Record it safely.

## Acceptance-criteria coverage
- AC-1 per-org creds, own tenant · AC-2 encrypted at rest, never leaked · AC-3 reached only via orgDb().graphCreds · AC-4 per-org connected gate + no-op without creds · AC-5 save-and-test · AC-6 global GRAPH_* removed, AW just an org · AC-7 many orgs per reconcile, caches keyed per tenant
