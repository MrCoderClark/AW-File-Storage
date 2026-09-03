// Microsoft Graph client for the Office 365 CustomAttribute1 sync (spec 0010).
// App-only (client credentials): no signed-in person, a background job. Reads its
// credentials from Worker secrets and is inert when they are absent, so the app
// runs normally without Graph configured.
//
// The tenant is cloud-only, so onPremisesExtensionAttributes.extensionAttribute1
// (= Exchange CustomAttribute1) is writable via PATCH /users/{id}. See the
// `msgraph` skill for the endpoint/permission details (User.ReadWrite.All).

export interface GraphEnv {
  GRAPH_TENANT_ID?: string;
  GRAPH_CLIENT_ID?: string;
  GRAPH_CLIENT_SECRET?: string;
  // Certificate auth (spec 0011), preferred over the secret when both are set.
  // Private key as a PKCS8 PEM; thumbprint as the cert's SHA-1 fingerprint (hex
  // from `openssl x509 -fingerprint -sha1`, or an already-base64url value).
  GRAPH_CLIENT_CERT_PRIVATE_KEY?: string;
  GRAPH_CLIENT_CERT_THUMBPRINT?: string;
}

/** True when a certificate (private key + thumbprint) is configured. */
export function usesCertificate(env: GraphEnv): boolean {
  return Boolean(
    env.GRAPH_CLIENT_CERT_PRIVATE_KEY && env.GRAPH_CLIENT_CERT_THUMBPRINT,
  );
}

/**
 * True when Graph can authenticate: the tenant + client id, plus EITHER a
 * certificate OR a client secret (spec 0011). This is the platform-level gate;
 * a card also needs its OWN org's O365 toggle on (spec 0012, see
 * o365-sync.ts `o365EnabledForOrg`). Credentials gate, the per-org toggle switches.
 */
export function graphConfigured(env: GraphEnv): boolean {
  return Boolean(
    env.GRAPH_TENANT_ID &&
      env.GRAPH_CLIENT_ID &&
      (usesCertificate(env) || env.GRAPH_CLIENT_SECRET),
  );
}

export interface GraphUser {
  id: string;
  mail: string | null;
  userPrincipalName: string | null;
  /** Current value of extensionAttribute1, for idempotent diffing. */
  currentAttr: string | null;
}

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

// Access token cached at module scope (survives within a Worker isolate). Graph
// app tokens last ~1 hour; we refresh a minute early.
let tokenCache: { token: string; expiresAt: number } | null = null;

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

// The imported signing key is cached at module scope (the PEM is stable).
let signingKeyCache: CryptoKey | null = null;

async function getSigningKey(pem: string): Promise<CryptoKey> {
  if (signingKeyCache) return signingKeyCache;
  signingKeyCache = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return signingKeyCache;
}

/**
 * Build a signed JWT client assertion for the client-credentials flow (spec
 * 0011). Signed RS256 with the cert's private key via Web Crypto.
 */
export async function buildClientAssertion(env: GraphEnv): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT",
    x5t: thumbprintToX5t(env.GRAPH_CLIENT_CERT_THUMBPRINT ?? ""),
  };
  const payload = {
    aud: `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID}/oauth2/v2.0/token`,
    iss: env.GRAPH_CLIENT_ID,
    sub: env.GRAPH_CLIENT_ID,
    jti: crypto.randomUUID(),
    iat: now,
    nbf: now,
    exp: now + 300,
  };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const key = await getSigningKey(env.GRAPH_CLIENT_CERT_PRIVATE_KEY ?? "");
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(sig)}`;
}

async function getToken(env: GraphEnv): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.token;
  }
  // Prefer the certificate (client assertion) when configured; else the secret.
  const body = new URLSearchParams({
    client_id: env.GRAPH_CLIENT_ID ?? "",
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  if (usesCertificate(env)) {
    body.set("client_assertion_type", CLIENT_ASSERTION_TYPE);
    body.set("client_assertion", await buildClientAssertion(env));
  } else {
    body.set("client_secret", env.GRAPH_CLIENT_SECRET ?? "");
  }
  const res = await fetch(
    `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID}/oauth2/v2.0/token`,
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
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return data.access_token;
}

/** A Graph request with bearer auth and 429/Retry-After backoff. */
async function graphFetch(
  env: GraphEnv,
  path: string,
  init: RequestInit = {},
  retries = 3,
): Promise<Response> {
  const token = await getToken(env);
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (res.status === 429 && retries > 0) {
    const retryAfter = Number(res.headers.get("retry-after") ?? "2");
    await sleep((Number.isFinite(retryAfter) ? retryAfter : 2) * 1000);
    return graphFetch(env, path, init, retries - 1);
  }
  return res;
}

/**
 * Users whose mail or userPrincipalName equals `email`, deduped by id. Two simple
 * `eq` queries (no advanced-query header needed). Zero results = no mailbox match;
 * more than one = ambiguous. Throws on a Graph error so the caller records it.
 */
export async function findUsersByEmail(
  env: GraphEnv,
  email: string,
): Promise<GraphUser[]> {
  const found = new Map<string, GraphUser>();
  for (const field of ["mail", "userPrincipalName"] as const) {
    const path = `/users?$filter=${field} eq '${odata(email)}'&$select=id,mail,userPrincipalName,onPremisesExtensionAttributes`;
    const res = await graphFetch(env, path);
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
  env: GraphEnv,
  userId: string,
): Promise<string | null> {
  const res = await graphFetch(
    env,
    `/users/${userId}?$select=onPremisesExtensionAttributes`,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Graph user read failed: ${res.status}`);
  const data = (await res.json()) as {
    onPremisesExtensionAttributes?: { extensionAttribute1?: string | null };
  };
  return data.onPremisesExtensionAttributes?.extensionAttribute1 ?? null;
}

/** Write (or clear, with null) a user's extensionAttribute1 = Exchange CustomAttribute1. */
export async function patchUserExtensionAttribute1(
  env: GraphEnv,
  userId: string,
  value: string | null,
): Promise<void> {
  const res = await graphFetch(env, `/users/${userId}`, {
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
