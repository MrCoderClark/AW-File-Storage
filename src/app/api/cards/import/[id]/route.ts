import { getCloudflareContext } from "@opennextjs/cloudflare";
import { orgDbFor } from "@/server/org-db";
import { requireApiRole } from "@/server/session";
import { publicUrlFor, type UploadEnv } from "@/server/uploads";

// Progress + per-row results for one bulk import (spec 0028 AC-6). The results UI polls
// this. Org-scoped: an import that isn't in the caller's active org reads as 404 (a
// tenant row in another org is indistinguishable from one that doesn't exist).
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiRole("member");
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const { env } = getCloudflareContext();
  const e = env as unknown as UploadEnv;
  const scoped = orgDbFor(auth.actor.orgId, e.DB);

  const imp = await scoped.cardImports.get(id);
  if (!imp) {
    return Response.json(
      { ok: false, error: "Import not found." },
      { status: 404 },
    );
  }
  const rows = await scoped.cardImports.listRows(id);

  return Response.json({
    ok: true,
    importId: imp.id,
    status: imp.status,
    total: imp.totalRows,
    published: imp.publishedCount,
    skipped: imp.skippedCount,
    failed: imp.failedCount,
    completedAt: imp.completedAt,
    rows: rows.map((r) => ({
      rowNumber: r.rowNumber,
      contactName: r.contactName,
      outcome: r.outcome,
      reason: r.reason,
      publicUrl:
        r.outcome === "published" ? publicUrlFor(e, r.publicSlug) : undefined,
    })),
  });
}
