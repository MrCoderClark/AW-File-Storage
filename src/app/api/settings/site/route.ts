import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  type AppSettingsEnv,
  getAppSettings,
  setRequireAppHostCardLogin,
} from "@/server/app-settings";
import { requireApiRole } from "@/server/session";

// Site-wide settings (spec 0009 follow-up). Owner/admin only. Currently one
// toggle: whether card pages on the app host (www) require a sign-in.
export async function GET() {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { env } = getCloudflareContext();
  const settings = await getAppSettings(env as unknown as AppSettingsEnv);
  return Response.json({ ok: true, settings });
}

export async function PUT(req: Request) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
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
