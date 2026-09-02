import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  type AppSettingsEnv,
  getAppSettings,
  setO365SyncEnabled,
} from "@/server/app-settings";
import { type GraphEnv, graphConfigured } from "@/server/graph";
import { type O365SyncEnv, o365Summary } from "@/server/o365-sync";
import { requireApiRole } from "@/server/session";

// Office 365 sync settings (spec 0010). Owner/admin only. GET returns the toggle,
// whether credentials are configured, and a per-org status summary; PUT flips the
// toggle. Credentials themselves stay as Worker secrets and are never returned.
export async function GET() {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { env } = getCloudflareContext();
  const settings = await getAppSettings(env as unknown as AppSettingsEnv);
  const configured = graphConfigured(env as unknown as GraphEnv);
  const summary = await o365Summary(
    env as unknown as O365SyncEnv,
    auth.actor.orgId,
  );
  return Response.json({
    ok: true,
    enabled: settings.o365SyncEnabled,
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
  await setO365SyncEnabled(env as unknown as AppSettingsEnv, body.enabled);
  return Response.json({ ok: true });
}
