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
}

/**
 * True when the three Graph credentials are present. The sync also needs the
 * Settings toggle on (see o365-sync.ts `o365Active`); credentials gate, the
 * toggle switches.
 */
export function graphConfigured(env: GraphEnv): boolean {
  return Boolean(
    env.GRAPH_TENANT_ID && env.GRAPH_CLIENT_ID && env.GRAPH_CLIENT_SECRET,
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

async function getToken(env: GraphEnv): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.token;
  }
  const res = await fetch(
    `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GRAPH_CLIENT_ID ?? "",
        client_secret: env.GRAPH_CLIENT_SECRET ?? "",
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
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
