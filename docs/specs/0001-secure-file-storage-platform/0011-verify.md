# Verify: O365 certificate auth + least privilege · spec 0011 · updated 2026-09-03
_Steps derived from spec 0011 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## Code (done)
- [ ] `npx vitest run test/graph.test.ts` → 3 pass (assertion well-formed, signature verifies, cert-over-secret selection) → AC-1, AC-2, AC-3
- [ ] `npx opennextjs-cloudflare build` → bundles cleanly
- [ ] With **no** cert secrets set: the sync behaves exactly as today (secret flow) → AC-2

## Operator runbook — roll out strangler-style (reversible at each step)

### Phase 1 — deploy cert-capable code (no behavior change)
- [ ] Merge this branch + `npm run deploy`. With only `GRAPH_CLIENT_SECRET` still set, the app keeps using the secret. Verify a card sync still writes CustomAttribute1.

### Phase 2 — add the certificate
- [ ] Generate a self-signed cert + PKCS8 private key:
  ```bash
  openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 730 -nodes -subj "/CN=aw-file-storage-graph"
  openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pk8.pem
  openssl x509 -in cert.pem -fingerprint -sha1 -noout   # prints: sha1 Fingerprint=AB:CD:...
  ```
- [ ] Entra → the app registration → **Certificates & secrets → Certificates → Upload** `cert.pem`.
- [ ] Set Worker secrets:
  ```bash
  npx wrangler secret put GRAPH_CLIENT_CERT_PRIVATE_KEY   # paste the contents of key.pk8.pem
  npx wrangler secret put GRAPH_CLIENT_CERT_THUMBPRINT    # ONLY the hex after the "=", e.g. AB:CD:EF:... (colons OK, NO "sha1 Fingerprint=" prefix)
  npm run deploy
  ```
  > **Gotcha:** the thumbprint secret must be **only** the 40-hex string. `graph.ts` recognizes a clean hex value (colons/spaces stripped) and converts it to the base64url `x5t`; anything else (e.g. the whole `sha1 Fingerprint=...` line) is passed through verbatim as a bad `x5t`, and every token request fails with **401** (`Graph token request failed: 401` on every card). Paste the characters after the `=` only.
- [ ] Verify: the app now signs in with the cert (a card sync still writes CustomAttribute1). → AC-1
- [ ] Rollback: unset the two cert secrets → the app falls back to the secret. → AC-6

### Phase 3 — scope the permission to an Administrative Unit
- [ ] Entra → **Administrative units** → create one (e.g. "AW Staff Cards") → add the staff user accounts.
- [ ] Entra → **Roles & admins → custom roles** → new custom role with only the user-update action for cloud extension attributes (confirm the exact action in the builder; candidate: `microsoft.directory/users/extensionAttributesForCloudUsers/update`). **Record the action name in spec 0011 follow-up.**
- [ ] Assign that custom role to the app's **service principal**, **scoped to the AU**.
- [ ] Verify: a card whose email is a user **inside** the AU still syncs. → AC-4

### Phase 4 — remove the tenant-wide permission
- [ ] Entra → the app registration → **API permissions** → remove `User.ReadWrite.All` and revoke its admin consent.
- [ ] Verify: an in-AU card still syncs; a card whose email is a user **outside** the AU now fails to write (status `error` on the Files row / Settings summary). → AC-4
- [ ] Rollback: re-add `User.ReadWrite.All` + consent if the scoped write fails.

### Phase 5 — remove the secret
- [ ] `npx wrangler secret delete GRAPH_CLIENT_SECRET` and delete the client secret in the app registration. Only after phases 2–4 are proven.

## Hygiene
- [ ] The private key / secret appear only in Worker secrets — not in code, the client bundle, the DB, git, or logs. → AC-5
- [ ] Calendar the certificate expiry (2 years here) for re-issue.

## Acceptance-criteria coverage
- AC-1 cert token · AC-2 secret fallback · AC-3 graphConfigured accepts either · AC-4 AU-scoped write (in-AU ok, out-of-AU denied) · AC-5 no key/secret leakage · AC-6 reversible at each phase
