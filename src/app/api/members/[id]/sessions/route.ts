import { getCloudflareContext } from "@opennextjs/cloudflare";
import { MemberError, revokeMemberSessions } from "@/server/members";
import { requireApiRole } from "@/server/session";

// Revoke all of a member's sessions (spec 0005 AC-11). Owner/admin only.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const { env } = getCloudflareContext();
  try {
    const revoked = await revokeMemberSessions({
      env: env as unknown as { DB: D1Database },
      orgId: auth.actor.orgId,
      actorUserId: auth.actor.userId,
      actorRole: auth.actor.role,
      memberId: id,
    });
    return Response.json({ ok: true, revoked });
  } catch (e) {
    if (e instanceof MemberError) {
      return Response.json({ ok: false, error: e.message }, { status: e.status });
    }
    throw e;
  }
}
