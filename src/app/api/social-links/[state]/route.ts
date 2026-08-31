import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requireApiRole } from "@/server/session";
import { deleteSocialLink, type SocialLinksEnv } from "@/server/social-links";

// Remove one state's social-link row (owner/admin). The `*` default is passed
// url-encoded, so decode before use.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ state: string }> },
) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { state } = await params;
  const { env } = getCloudflareContext();
  await deleteSocialLink(
    env as unknown as SocialLinksEnv,
    auth.actor.orgId,
    decodeURIComponent(state),
  );
  return Response.json({ ok: true });
}
