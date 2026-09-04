import { getCloudflareContext } from "@opennextjs/cloudflare";
import { type AuthEnv } from "@/server/auth";
import { requirePlatformOwner } from "@/server/platform";
import { suggestOrgForEmail } from "@/server/provisioning";

// Suggest the org for an email by its verified domain (spec 0014), for the
// console's pre-select. Platform-owner only. Returns null when there's no match
// (consumer domain / no verified claim).
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const guard = await requirePlatformOwner();
  if (!guard.ok) return guard.response;
  const email = new URL(req.url).searchParams.get("email") ?? "";
  const env = getCloudflareContext().env as unknown as AuthEnv;
  return Response.json({ ok: true, match: await suggestOrgForEmail(env, email) });
}
