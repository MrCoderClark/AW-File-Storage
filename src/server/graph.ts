// Microsoft Graph client for the Office 365 CustomAttribute1 sync (spec 0010).
// App-only (client credentials): no signed-in person, a background job. Reads its
// credentials from Worker secrets and is inert when they are absent, so the app
// runs normally without Graph configured.
//
// The tenant is cloud-only, so onPremisesExtensionAttributes.extensionAttribute1
// (= Exchange CustomAttribute1) is writable via PATCH /users/{id}. See the
// `msgraph` skill for the endpoint/permission details (User.ReadWrite.All).

/**
 * One organization's decrypted Microsoft Graph credentials (spec 0013). Each org
 * brings its OWN Entra app, so these are per-org, never global. `secret` and
 * `certPrivateKey` are the decrypted forms (ciphertext lives in the DB; the KEK
 * decrypts them in the O365 layer). `certPrivateKey` is a PKCS8 PEM; `certThumbprint`
 * is the cert's SHA-1 fingerprint (hex from `openssl x509 -fingerprint -sha1`, or an
 * already-base64url value).
 */
export interface GraphCreds {
  tenantId: string;
  clientId: string;
  method: "secret" | "certificate";
  secret?: string | null;
  certPrivateKey?: string | null;
  certThumbprint?: string | null;
}

/** True when these creds use (and have) a certificate. */
function usesCertificate(c: GraphCreds): boolean {
  return c.method === "certificate" && Boolean(c.certPrivateKey && c.certThumbprint);
}

/**
 * True when an org's creds can authenticate: a tenant + client id, plus a usable
 * secret OR certificate (spec 0013). This is the per-org credentials gate; a card
 * also needs its org's O365 toggle on (spec 0012, see o365-sync.ts
 * `o365EnabledForOrg`). Credentials gate, the toggle switches.
 */
export function graphConfiguredForOrg(c: GraphCreds | null | undefined): boolean {
  if (!c || !c.tenantId || !c.clientId) return false;
  return c.method === "certificate"
    ? Boolean(c.certPrivateKey && c.certThumbprint)
    : Boolean(c.secret);
}

export interface GraphUser {
  id: string;
  mail: string | null;
  userPrincipalName: string | null;
  /** Current value of extensionAttribute1, for idempotent diffing. */
  currentAttr: string | null;
}

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

// Access tokens cached at module scope, keyed per tenant+client so many orgs
// coexist in one isolate (spec 0013). Graph app tokens last ~1 hour; refreshed a
// minute early.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Cache key for a set of creds: the tenant + client uniquely identify a token. */
function credKey(c: GraphCreds): string {
  return `${c.tenantId}:${c.clientId}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Escape a value for an OData string literal (single quotes are doubled). */
function odata(value: string): string {
  return value.replace(/'/g, "''");
}

// --- Certificate client assertion (spec 0011), all via Web Crypto ---

const CLIENT_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/** base64url (no padding) of raw bytes. */
function b64url(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url of a JSON object (JWT header/payload). */
function b64urlJson(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

/** Strip a PEM's header/footer and base64-decode the body to DER bytes. */
function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/**
 * The `x5t` header value: base64url of the cert's raw SHA-1 thumbprint. Accepts
 * the openssl hex fingerprint (with or without colons) or an already-base64url
 * value.
 */
function thumbprintToX5t(value: string): string {
  const cleaned = value.replace(/[:\s]/g, "");
  if (/^[0-9a-fA-F]{40}$/.test(cleaned)) {
    const bytes = new Uint8Array(
      (cleaned.match(/../g) ?? []).map((h) => Number.parseInt(h, 16)),
    );
    return b64url(bytes);
  }
  return value.trim();
}

// Imported signing keys cached per tenant+client (each org has its own cert).
const signingKeyCache = new Map<string, CryptoKey>();

async function getSigningKey(c: GraphCreds): Promise<CryptoKey> {
  const k = credKey(c);
  const cached = signingKeyCache.get(k);
  if (cached) return cached;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(c.certPrivateKey ?? ""),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  signingKeyCache.set(k, key);
  return key;
}

/**
 * Build a signed JWT client assertion for the client-credentials flow (spec
 * 0011). Signed RS256 with the cert's private key via Web Crypto.
 */
export async function buildClientAssertion(c: GraphCreds): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT",
    x5t: thumbprintToX5t(c.certThumbprint ?? ""),
  };
  const payload = {
    aud: `https://login.microsoftonline.com/${c.tenantId}/oauth2/v2.0/token`,
    iss: c.clientId,
    sub: c.clientId,
    jti: crypto.randomUUID(),
    iat: now,
    nbf: now,
    exp: now + 300,
  };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const key = await getSigningKey(c);
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(sig)}`;
}

async function getToken(c: GraphCreds): Promise<string> {
  const cached = tokenCache.get(credKey(c));
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }
  // Certificate (client assertion) when this org uses one; else its client secret.
  const body = new URLSearchParams({
    client_id: c.clientId,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  if (usesCertificate(c)) {
    body.set("client_assertion_type", CLIENT_ASSERTION_TYPE);
    body.set("client_assertion", await buildClientAssertion(c));
  } else {
    body.set("client_secret", c.secret ?? "");
  }
  const res = await fetch(
    `https://login.microsoftonline.com/${c.tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  );
  if (!res.ok) {
    throw new Error(`Graph token request failed: ${res.status}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache.set(credKey(c), {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  });
  return data.access_token;
}

/** A Graph request with bearer auth and 429/Retry-After backoff. */
async function graphFetch(
  c: GraphCreds,
  path: string,
  init: RequestInit = {},
  retries = 3,
): Promise<Response> {
  const token = await getToken(c);
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (res.status === 429 && retries > 0) {
    const retryAfter = Number(res.headers.get("retry-after") ?? "2");
    await sleep((Number.isFinite(retryAfter) ? retryAfter : 2) * 1000);
    return graphFetch(c, path, init, retries - 1);
  }
  return res;
}

/**
 * Users whose mail or userPrincipalName equals `email`, deduped by id. Two simple
 * `eq` queries (no advanced-query header needed). Zero results = no mailbox match;
 * more than one = ambiguous. Throws on a Graph error so the caller records it.
 */
export async function findUsersByEmail(
  c: GraphCreds,
  email: string,
): Promise<GraphUser[]> {
  const found = new Map<string, GraphUser>();
  for (const field of ["mail", "userPrincipalName"] as const) {
    const path = `/users?$filter=${field} eq '${odata(email)}'&$select=id,mail,userPrincipalName,onPremisesExtensionAttributes`;
    const res = await graphFetch(c, path);
    if (!res.ok) throw new Error(`Graph user query failed: ${res.status}`);
    const data = (await res.json()) as {
      value?: Array<{
        id: string;
        mail: string | null;
        userPrincipalName: string | null;
        onPremisesExtensionAttributes?: { extensionAttribute1?: string | null };
      }>;
    };
    for (const u of data.value ?? []) {
      found.set(u.id, {
        id: u.id,
        mail: u.mail,
        userPrincipalName: u.userPrincipalName,
        currentAttr: u.onPremisesExtensionAttributes?.extensionAttribute1 ?? null,
      });
    }
  }
  return [...found.values()];
}

/** Read one user's current extensionAttribute1 (for the reconcile diff). */
export async function getUserExtensionAttribute1(
  c: GraphCreds,
  userId: string,
): Promise<string | null> {
  const res = await graphFetch(
    c,
    `/users/${userId}?$select=onPremisesExtensionAttributes`,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Graph user read failed: ${res.status}`);
  const data = (await res.json()) as {
    onPremisesExtensionAttributes?: { extensionAttribute1?: string | null };
  };
  return data.onPremisesExtensionAttributes?.extensionAttribute1 ?? null;
}

/**
 * Save-and-test (spec 0013): acquire a token with these creds (validates tenant /
 * client id / secret or cert) and do one trivial directory read (validates the app
 * can reach users). Throws with the status on any failure so the caller can show it.
 */
export async function graphTestConnection(c: GraphCreds): Promise<void> {
  const res = await graphFetch(c, "/users?$top=1&$select=id");
  if (!res.ok) throw new Error(`Graph test failed: ${res.status}`);
}

/**
 * The tenant's VERIFIED domains (spec 0014), lower-cased, for domain-based
 * provisioning. Graph `GET /domains` returns each domain's id (the domain name)
 * and `isVerified`; only verified domains are kept. Throws on a Graph error.
 */
export async function getVerifiedDomains(c: GraphCreds): Promise<string[]> {
  const res = await graphFetch(c, "/domains?$select=id,isVerified");
  if (!res.ok) throw new Error(`Graph domains query failed: ${res.status}`);
  const data = (await res.json()) as {
    value?: Array<{ id: string; isVerified?: boolean }>;
  };
  return (data.value ?? [])
    .filter((d) => d.isVerified)
    .map((d) => d.id.trim().toLowerCase())
    .filter(Boolean);
}

/** Write (or clear, with null) a user's extensionAttribute1 = Exchange CustomAttribute1. */
export async function patchUserExtensionAttribute1(
  c: GraphCreds,
  userId: string,
  value: string | null,
): Promise<void> {
  const res = await graphFetch(c, `/users/${userId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      onPremisesExtensionAttributes: { extensionAttribute1: value },
    }),
  });
  if (!res.ok) {
    throw new Error(`Graph PATCH user failed: ${res.status}`);
  }
}
