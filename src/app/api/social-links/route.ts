import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requireApiRole } from "@/server/session";
import {
  listSocialLinks,
  SocialLinkError,
  type SocialLinksEnv,
  upsertSocialLink,
} from "@/server/social-links";

// Regional social links for signatures (spec 0009 follow-up). Owner/admin only.
export async function GET() {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { env } = getCloudflareContext();
  const links = await listSocialLinks(
    env as unknown as SocialLinksEnv,
    auth.actor.orgId,
  );
  return Response.json({ ok: true, links });
}

export async function PUT(req: Request) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const body = (await req.json().catch(() => ({}))) as {
    state?: string;
    facebook?: string;
    x?: string;
    instagram?: string;
  };
  const { env } = getCloudflareContext();
  try {
    await upsertSocialLink(env as unknown as SocialLinksEnv, auth.actor.orgId, {
      state: body.state ?? "",
      facebook: body.facebook,
      x: body.x,
      instagram: body.instagram,
    });
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof SocialLinkError) {
      return Response.json({ ok: false, error: e.message }, { status: e.status });
    }
    throw e;
  }
}
