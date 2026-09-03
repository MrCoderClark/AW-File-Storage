import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  type GraphCreds,
  graphConfiguredForOrg,
  graphTestConnection,
} from "@/server/graph";
import { orgDbFor } from "@/server/org-db";
import { encryptSecret } from "@/server/secret-box";
import { requireApiRole } from "@/server/session";

// Per-org Office 365 / Entra credentials (spec 0013). Owner/admin only. Each org
// brings its OWN app. Secrets/keys are encrypted at rest and NEVER returned.
//  GET    → non-secret status (configured, tenant/client/method, last verified).
//  PUT    → save-and-test: validate against the org's tenant, then encrypt + store.
//  DELETE → disconnect (clear the row).
export const dynamic = "force-dynamic";

interface Env {
  DB: D1Database;
  O365_CRED_KEK?: string;
}

export async function GET() {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { env } = getCloudflareContext();
  const row = await orgDbFor(auth.actor.orgId, (env as unknown as Env).DB).graphCreds.get();
  return Response.json({
    ok: true,
    // No secret/key material ever leaves the server.
    configured: Boolean(row),
    tenantId: row?.tenantId ?? "",
    clientId: row?.clientId ?? "",
    method: row?.authMethod ?? "secret",
    thumbprint: row?.certThumbprint ?? "",
    lastVerifiedAt: row?.lastVerifiedAt ? row.lastVerifiedAt.getTime() : null,
  });
}

export async function PUT(req: Request) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { env } = getCloudflareContext();
  const kek = (env as unknown as Env).O365_CRED_KEK;
  if (!kek) {
    return Response.json(
      { ok: false, error: "Server is missing O365_CRED_KEK; contact the operator." },
      { status: 503 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    tenantId?: string;
    clientId?: string;
    method?: "secret" | "certificate";
    secret?: string;
    certPrivateKey?: string;
    certThumbprint?: string;
  };
  const tenantId = body.tenantId?.trim();
  const clientId = body.clientId?.trim();
  const method = body.method === "certificate" ? "certificate" : "secret";
  if (!tenantId || !clientId) {
    return Response.json(
      { ok: false, error: "Tenant ID and Client ID are required." },
      { status: 400 },
    );
  }

  // Build the decrypted creds to test with. Secret/key come from the request only
  // on entry; they are never read back out, so a save must include them.
  const creds: GraphCreds = { tenantId, clientId, method };
  if (method === "secret") {
    creds.secret = body.secret?.trim();
  } else {
    creds.certPrivateKey = body.certPrivateKey;
    creds.certThumbprint = body.certThumbprint?.trim();
  }
  if (!graphConfiguredForOrg(creds)) {
    return Response.json(
      {
        ok: false,
        error:
          method === "secret"
            ? "A client secret is required."
            : "A certificate private key and thumbprint are required.",
      },
      { status: 400 },
    );
  }

  // Save-and-test: verify BEFORE storing, so an invalid credential never becomes
  // the active connection (AC-5).
  try {
    await graphTestConnection(creds);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json(
      { ok: false, error: `Could not connect: ${message}` },
      { status: 400 },
    );
  }

  // Encrypt the secret material, then store. Tenant/client/thumbprint are not secret.
  const now = new Date();
  const scoped = orgDbFor(auth.actor.orgId, (env as unknown as Env).DB);
  if (method === "secret") {
    const sealed = await encryptSecret(kek, creds.secret ?? "");
    await scoped.graphCreds.set({
      tenantId,
      clientId,
      authMethod: "secret",
      secretCt: sealed.ct,
      secretIv: sealed.iv,
      certKeyCt: null,
      certKeyIv: null,
      certThumbprint: null,
      lastVerifiedAt: now,
    });
  } else {
    const sealed = await encryptSecret(kek, creds.certPrivateKey ?? "");
    await scoped.graphCreds.set({
      tenantId,
      clientId,
      authMethod: "certificate",
      secretCt: null,
      secretIv: null,
      certKeyCt: sealed.ct,
      certKeyIv: sealed.iv,
      certThumbprint: creds.certThumbprint ?? null,
      lastVerifiedAt: now,
    });
  }

  return Response.json({ ok: true, connected: true });
}

export async function DELETE() {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { env } = getCloudflareContext();
  await orgDbFor(auth.actor.orgId, (env as unknown as Env).DB).graphCreds.clear();
  return Response.json({ ok: true });
}
