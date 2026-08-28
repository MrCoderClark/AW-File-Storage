import { getCloudflareContext } from "@opennextjs/cloudflare";
import { type AuthEnv } from "@/server/auth";
import { InviteError, resendInvitation } from "@/server/invitations";
import { requireApiRole } from "@/server/session";

// Resend an invitation: cancel + reissue, so the old link dies (spec 0005 AC-3).
// Rate limited per org+email (AC-16 → 429). Owner/admin only.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const { env } = getCloudflareContext();
  try {
    const result = await resendInvitation({
      env: env as unknown as AuthEnv,
      orgId: auth.actor.orgId,
      actorUserId: auth.actor.userId,
      invitationId: id,
    });
    return Response.json({ ok: true, invitationId: result.id });
  } catch (e) {
    if (e instanceof InviteError) {
      return Response.json({ ok: false, error: e.message }, { status: e.status });
    }
    throw e;
  }
}
