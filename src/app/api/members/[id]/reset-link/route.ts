import { getCloudflareContext } from "@opennextjs/cloudflare";
import { type AuthEnv } from "@/server/auth";
import { MemberError, sendMemberResetLink } from "@/server/members";
import { requireApiRole } from "@/server/session";

// Send (and return) a password-reset link for a member (scope extension). The
// link is emailed and also returned so an admin can share it while email
// delivery is unconfigured. Owner/admin only.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const { env } = getCloudflareContext();
  try {
    const result = await sendMemberResetLink({
      env: env as unknown as AuthEnv,
      orgId: auth.actor.orgId,
      actorUserId: auth.actor.userId,
      actorRole: auth.actor.role,
      memberId: id,
    });
    return Response.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof MemberError) {
      return Response.json({ ok: false, error: e.message }, { status: e.status });
    }
    throw e;
  }
}
