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
  const { o365SyncEnabled, o365AutoCardEnabled } = await scoped.settings.get();
  const configured = Boolean(await scoped.graphCreds.get());
  const summary = await o365Summary(
    env as unknown as O365SyncEnv,
    auth.actor.orgId,
  );
  return Response.json({
    ok: true,
    enabled: o365SyncEnabled,
    autoCardEnabled: o365AutoCardEnabled,
    configured,
    summary,
  });
}

// PUT flips either toggle: { enabled } for the URL sync, { autoCardEnabled } for
// directory auto-provisioning (spec 0016). Either or both may be present.
export async function PUT(req: Request) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const body = (await req.json().catch(() => ({}))) as {
    enabled?: boolean;
    autoCardEnabled?: boolean;
  };
  if (
    typeof body.enabled !== "boolean" &&
    typeof body.autoCardEnabled !== "boolean"
  ) {
    return Response.json(
      { ok: false, error: "enabled and/or autoCardEnabled (boolean) required." },
      { status: 400 },
    );
  }
  const { env } = getCloudflareContext();
  const scoped = orgDbFor(auth.actor.orgId, env.DB);
  if (typeof body.enabled === "boolean") {
    await scoped.settings.setO365SyncEnabled(body.enabled);
  }
  if (typeof body.autoCardEnabled === "boolean") {
    await scoped.settings.setO365AutoCardEnabled(body.autoCardEnabled);
  }
  return Response.json({ ok: true });
}
