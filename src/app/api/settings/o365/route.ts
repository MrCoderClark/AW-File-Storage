import { getCloudflareContext } from "@opennextjs/cloudflare";
import { type O365SyncEnv, o365Summary } from "@/server/o365-sync";
import { orgDbFor } from "@/server/org-db";
import { requireApiRole } from "@/server/session";

// Office 365 sync settings (spec 0010/0013). Owner/admin only. GET returns the
// per-org toggle, whether THIS org's credentials are configured, and a status
// summary; PUT flips the toggle. Credentials are managed at .../o365/credentials
// and are never returned. `configured` is true when the org has a credentials row.
export async function GET() {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { env } = getCloudflareContext();
  const scoped = orgDbFor(auth.actor.orgId, env.DB);
  const { o365SyncEnabled } = await scoped.settings.get();
  const configured = Boolean(await scoped.graphCreds.get());
  const summary = await o365Summary(
    env as unknown as O365SyncEnv,
    auth.actor.orgId,
  );
  return Response.json({
    ok: true,
    enabled: o365SyncEnabled,
    configured,
    summary,
  });
}

export async function PUT(req: Request) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const body = (await req.json().catch(() => ({}))) as { enabled?: boolean };
  if (typeof body.enabled !== "boolean") {
    return Response.json(
      { ok: false, error: "enabled (boolean) is required." },
      { status: 400 },
    );
  }
  const { env } = getCloudflareContext();
  await orgDbFor(auth.actor.orgId, env.DB).settings.setO365SyncEnabled(
    body.enabled,
  );
  return Response.json({ ok: true });
}
