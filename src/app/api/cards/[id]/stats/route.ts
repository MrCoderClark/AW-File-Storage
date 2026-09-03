import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cardStatDetail } from "@/server/card-stats";
import { orgDbFor } from "@/server/org-db";
import { getActor } from "@/server/session";
import type { UploadEnv } from "@/server/uploads";

// Engagement stats for one published card (spec 0008, AC-7). Authenticated and
// org-scoped: owners/admins may read any card in the org, a member only their own
// (mirroring the Files management scope). Returns all-time totals plus a daily
// series for the trend view.
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActor();
  if (!actor) return Response.json({ ok: false }, { status: 401 });

  const { id } = await params;
  const { env } = getCloudflareContext();
  const uploadEnv = env as unknown as UploadEnv;

  // Org scope: a file in another org is indistinguishable from one that is absent.
  const scoped = orgDbFor(actor.orgId, uploadEnv.DB);
  const file = await scoped.files.get(id);
  if (!file || file.deletedAt) {
    return Response.json({ ok: false }, { status: 404 });
  }
  // Members see only their own cards' numbers.
  if (!actor.canManageAny && file.uploadedBy !== actor.userId) {
    return Response.json({ ok: false }, { status: 403 });
  }

  const daysRaw = Number(new URL(req.url).searchParams.get("days"));
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 365) : 30;

  const detail = await cardStatDetail(uploadEnv, actor.orgId, id, days);
  return Response.json({ ok: true, name: file.originalName, ...detail });
}
