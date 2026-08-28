import { getCloudflareContext } from "@opennextjs/cloudflare";
import { MemberError, resetMemberTwoFactor } from "@/server/members";
import { requireApiRole } from "@/server/session";

// Reset a member's second factor so they must enrol again (spec 0005 AC-11).
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const { env } = getCloudflareContext();
  try {
    await resetMemberTwoFactor({
      env: env as unknown as { DB: D1Database },
      orgId: auth.actor.orgId,
      actorUserId: auth.actor.userId,
      memberId: id,
    });
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof MemberError) {
      return Response.json({ ok: false, error: e.message }, { status: e.status });
    }
    throw e;
  }
}
