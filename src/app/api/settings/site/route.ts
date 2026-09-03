import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  type AppSettingsEnv,
  getAppSettings,
  setRequireAppHostCardLogin,
} from "@/server/app-settings";
import { isPlatformOwner } from "@/server/platform";
import { requireApiRole } from "@/server/session";

// Platform-level site settings (spec 0009 / 0012). The card-login gate is a
// host-level policy shared by all orgs (it is checked before any card is
// resolved), so — unlike per-org settings — CHANGING it is restricted to the
// platform ("app") owner (spec 0012). Any admin may READ it (GET) to see the
// current state; only the platform owner may write it (PUT).
export async function GET() {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { env } = getCloudflareContext();
  const settings = await getAppSettings(env as unknown as AppSettingsEnv);
  return Response.json({
    ok: true,
    settings,
    canEdit: await isPlatformOwner(),
  });
}

export async function PUT(req: Request) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  // Platform-level control: an org admin is not enough — only the app owner.
  if (!(await isPlatformOwner())) {
    return Response.json(
      { ok: false, error: "Only the platform owner can change this setting." },
      { status: 403 },
    );
  }
  const body = (await req.json().catch(() => ({}))) as {
    requireAppHostCardLogin?: boolean;
  };
  if (typeof body.requireAppHostCardLogin !== "boolean") {
    return Response.json(
      { ok: false, error: "requireAppHostCardLogin (boolean) is required." },
      { status: 400 },
    );
  }
  const { env } = getCloudflareContext();
  await setRequireAppHostCardLogin(
    env as unknown as AppSettingsEnv,
    body.requireAppHostCardLogin,
  );
  return Response.json({ ok: true });
}
