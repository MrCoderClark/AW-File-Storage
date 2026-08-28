import { getCloudflareContext } from "@opennextjs/cloudflare";
import { type AuthEnv } from "@/server/auth";
import { adminSetPassword, MemberError } from "@/server/members";
import { requireApiRole } from "@/server/session";

// Admin-set a member's password (scope extension). Owner/admin only. Revokes the
// member's sessions so the new password takes effect immediately.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const body = (await req.json().catch(() => ({}))) as { password?: string };
  if (!body.password) {
    return Response.json(
      { ok: false, error: "A password is required." },
      { status: 400 },
    );
  }

  const { env } = getCloudflareContext();
  try {
    await adminSetPassword({
      env: env as unknown as AuthEnv,
      orgId: auth.actor.orgId,
      actorUserId: auth.actor.userId,
      memberId: id,
      newPassword: body.password,
    });
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof MemberError) {
      return Response.json({ ok: false, error: e.message }, { status: e.status });
    }
    throw e;
  }
}
