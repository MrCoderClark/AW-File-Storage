import { getCloudflareContext } from "@opennextjs/cloudflare";
import { type AuthEnv } from "@/server/auth";
import { requirePlatformOwner } from "@/server/platform";
import { lookupEmail } from "@/server/provisioning";

// Look up an email for the console (spec 0014): the domain-suggested org, which
// orgs it already belongs to (to grey out), and whether the account exists.
// Platform-owner only.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const guard = await requirePlatformOwner();
  if (!guard.ok) return guard.response;
  const email = new URL(req.url).searchParams.get("email") ?? "";
  const env = getCloudflareContext().env as unknown as AuthEnv;
  const { match, existingOrgIds, accountExists } = await lookupEmail(env, email);
  return Response.json({ ok: true, match, existingOrgIds, accountExists });
}
