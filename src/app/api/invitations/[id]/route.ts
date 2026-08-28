import { getCloudflareContext } from "@opennextjs/cloudflare";
import { type AuthEnv } from "@/server/auth";
import { InviteError, revokeInvitation } from "@/server/invitations";
import { requireApiRole } from "@/server/session";

// Revoke a pending invitation (spec 0005 AC-3). Owner/admin only; org-scoped.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const { env } = getCloudflareContext();
  try {
    await revokeInvitation({
      env: env as unknown as AuthEnv,
      orgId: auth.actor.orgId,
      actorUserId: auth.actor.userId,
      invitationId: id,
    });
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof InviteError) {
      return Response.json({ ok: false, error: e.message }, { status: e.status });
    }
    throw e;
  }
}
