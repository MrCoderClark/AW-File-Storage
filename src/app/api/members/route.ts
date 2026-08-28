import { getCloudflareContext } from "@opennextjs/cloudflare";
import { type MemberListEnv, listMembers } from "@/server/members";
import { requireApiRole } from "@/server/session";

// Roster of the active organization (spec 0005 AC-2, AC-14, AC-15). Owner/admin
// only; the org is taken from the session, never the request.
export async function GET(req: Request) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;

  const { env } = getCloudflareContext();
  const result = await listMembers(env as unknown as MemberListEnv, {
    orgId: auth.actor.orgId,
    cursor,
    limit: Number.isFinite(limit) ? limit : undefined,
  });
  return Response.json({ ok: true, ...result });
}
