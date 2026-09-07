import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  actionsForCategory,
  type LogCategory,
  logActionPhrase,
  logCategory,
  logCategoryLabel,
  logDetail,
  logStatus,
} from "@/lib/log-format";
import { orgDbFor } from "@/server/org-db";
import { requireApiRole } from "@/server/session";

// Activity Logs feed (spec 0018). Open to any signed-in member of the org (read-only).
// Over the org's own audit_event rows; filtered, keyset-paginated, with each row
// decorated with its display category/status/detail.
export const dynamic = "force-dynamic";

const CATEGORIES = new Set<LogCategory>([
  "vcard", "onboard", "offboard", "sync", "error", "user", "file", "other",
]);

export async function GET(req: Request) {
  const auth = await requireApiRole("member");
  if (!auth.ok) return auth.response;
  const { env } = getCloudflareContext();
  const scoped = orgDbFor(auth.actor.orgId, env.DB);
  const url = new URL(req.url);

  // Date range: a number of days back, or "all".
  const rangeParam = url.searchParams.get("range") ?? "7";
  const days = rangeParam === "all" ? 0 : Math.max(1, Number(rangeParam) || 7);
  const sinceMs = days > 0 ? Date.now() - days * 86_400_000 : undefined;

  // Category → the concrete actions it covers.
  const cat = url.searchParams.get("category") as LogCategory | null;
  const actions =
    cat && CATEGORIES.has(cat) && cat !== "other"
      ? actionsForCategory(cat)
      : undefined;

  const q = url.searchParams.get("q") ?? undefined;

  // Cursor "<createdAtMs>.<id>".
  const cursorRaw = url.searchParams.get("cursor");
  let cursor: { at: number; id: string } | null = null;
  if (cursorRaw) {
    const dot = cursorRaw.indexOf(".");
    if (dot > 0) {
      const at = Number(cursorRaw.slice(0, dot));
      const id = cursorRaw.slice(dot + 1);
      if (Number.isFinite(at) && id) cursor = { at, id };
    }
  }

  const { items, nextCursor } = await scoped.audit.listPage({
    sinceMs,
    actions,
    q,
    cursor,
    limit: 40,
  });

  const rows = items.map((r) => ({
    id: r.id,
    at: r.createdAt.getTime(),
    category: logCategory(r.action),
    eventType: logCategoryLabel(r.action),
    action: logActionPhrase(r.action),
    status: logStatus(r.action),
    actor: r.actorName ?? (r.actorId ? "Unknown" : "System"),
    // Prefer a metadata detail (name/email/slug), then the resolved target name;
    // never fall back to the raw UUID (meaningless to a reader).
    detail: logDetail(r.metadataJson) || r.targetLabel || "",
    targetType: r.targetType,
    metadata: r.metadataJson,
  }));

  // Stats only on the first page (no cursor) — the header summary.
  const stats = cursor ? undefined : await scoped.audit.stats();

  return Response.json({
    ok: true,
    rows,
    nextCursor: nextCursor ? `${nextCursor.at}.${nextCursor.id}` : null,
    stats,
  });
}
