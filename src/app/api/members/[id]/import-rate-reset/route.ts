import { getCloudflareContext } from "@opennextjs/cloudflare";
import { MemberError, resetImportRateLimit } from "@/server/members";
import { requireApiRole } from "@/server/session";

// Reset one member's bulk-import rate limit (spec 0029). Owner/admin only, and the
// owner-tier rule applies (only an owner may reset an owner). Writes an
// `import.rate_reset` audit event; the blocked user can submit again immediately.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const { env } = getCloudflareContext();
  try {
    await resetImportRateLimit({
      env: env as unknown as { DB: D1Database },
      orgId: auth.actor.orgId,
      actorUserId: auth.actor.userId,
      actorRole: auth.actor.role,
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
