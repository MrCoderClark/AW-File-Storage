import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requireApiRole } from "@/server/session";
import { seedDefaultsFromBrand, type SocialLinksEnv } from "@/server/social-links";

// Copy the built-in signature defaults into this org's editable list (owner/admin).
export async function POST() {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { env } = getCloudflareContext();
  const inserted = await seedDefaultsFromBrand(
    env as unknown as SocialLinksEnv,
    auth.actor.orgId,
  );
  return Response.json({ ok: true, inserted });
}
