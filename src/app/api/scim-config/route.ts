import { getCloudflareContext } from "@opennextjs/cloudflare";
import { isPlatformOwner } from "@/server/platform";
import {
  disableOrgScimToken,
  getScimConfig,
  type ScimEnv,
  setOrgScimToken,
} from "@/server/scim";
import { requireApiRole } from "@/server/session";

// SCIM token management for the acting org (spec 0015). Platform owner only.
//  GET    → status (configured/active/last-used) + the base URL (no secret).
//  POST   → generate/rotate the token; returns the secret ONCE.
//  DELETE → disable SCIM for the org.
export const dynamic = "force-dynamic";

async function guard() {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return { ok: false as const, response: auth.response };
  if (!(await isPlatformOwner())) {
    return {
      ok: false as const,
      response: Response.json(
        { ok: false, error: "Platform owner only." },
        { status: 403 },
      ),
    };
  }
  return { ok: true as const, orgId: auth.actor.orgId, userId: auth.actor.userId };
}

export async function GET() {
  const g = await guard();
  if (!g.ok) return g.response;
  const { env } = getCloudflareContext();
  const config = await getScimConfig(env as unknown as ScimEnv, g.orgId);
  const appUrl = (env as unknown as { APP_URL?: string }).APP_URL ?? "";
  return Response.json({ ok: true, ...config, baseUrl: `${appUrl}/api/scim/v2` });
}

export async function POST() {
  const g = await guard();
  if (!g.ok) return g.response;
  const { env } = getCloudflareContext();
  const token = await setOrgScimToken(env as unknown as ScimEnv, g.orgId, g.userId);
  return Response.json({ ok: true, token }); // shown once
}

export async function DELETE() {
  const g = await guard();
  if (!g.ok) return g.response;
  const { env } = getCloudflareContext();
  await disableOrgScimToken(env as unknown as ScimEnv, g.orgId);
  return Response.json({ ok: true });
}
