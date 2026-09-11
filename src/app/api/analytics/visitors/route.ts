import { getCloudflareContext } from "@opennextjs/cloudflare";
import { type CardMetric, orgDbFor } from "@/server/org-db";
import { requireApiRole } from "@/server/session";
import { formatVisitorDevice } from "@/server/visits";

// Per-visitor engagement feed (spec 0030). Owner/admin only — the raw rows are
// personal data about outside visitors (AC-7). Over this org's own
// card_visit_event rows (AC-8); newest first, keyset-paginated, filterable by
// card and metric and a time range, each decorated with a resolved location,
// network, and read-time-derived device/browser, plus the unique visitor count
// for the current filter (AC-5, AC-6).
export const dynamic = "force-dynamic";

const METRICS = new Set<CardMetric>(["view", "scan", "download", "pdf"]);

/** "City, Region, Country" from whichever geo fields are present. */
function formatLocation(r: {
  city: string | null;
  region: string | null;
  country: string | null;
}): string {
  return [r.city, r.region, r.country].filter(Boolean).join(", ");
}

/** "Comcast (AS7922)" / "AS7922" / "" from the network fields. */
function formatNetwork(r: { asOrg: string | null; asn: number | null }): string {
  if (r.asOrg) return r.asn ? `${r.asOrg} (AS${r.asn})` : r.asOrg;
  return r.asn ? `AS${r.asn}` : "";
}

export async function GET(req: Request) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { env } = getCloudflareContext();
  const scoped = orgDbFor(auth.actor.orgId, env.DB);
  const url = new URL(req.url);

  const fileId = url.searchParams.get("fileId") || undefined;
  const metricParam = url.searchParams.get("metric");
  const metric =
    metricParam && METRICS.has(metricParam as CardMetric)
      ? (metricParam as CardMetric)
      : undefined;

  // Date range: a number of days back, or "all".
  const rangeParam = url.searchParams.get("range") ?? "30";
  const days = rangeParam === "all" ? 0 : Math.max(1, Number(rangeParam) || 30);
  const sinceMs = days > 0 ? Date.now() - days * 86_400_000 : undefined;

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

  const { items, nextCursor } = await scoped.visits.listPage({
    fileId,
    metric,
    sinceMs,
    cursor,
    limit: 40,
  });

  const rows = items.map((r) => ({
    id: r.id,
    at: r.createdAt.getTime(),
    metric: r.metric,
    fileId: r.fileId,
    card: r.cardName || r.cardOriginalName || "—",
    slug: r.slug,
    ip: r.ip,
    location: formatLocation(r),
    timezone: r.timezone,
    network: formatNetwork(r),
    device: formatVisitorDevice(r.userAgent),
    userAgent: r.userAgent,
    referrer: r.referrer,
    src: r.src,
  }));

  // The unique-visitor count is per-filter, not per-page: compute it only on the
  // first page (no cursor); the client holds it across "Load more" (like the
  // Activity Logs header stats).
  const uniqueVisitors = cursor
    ? undefined
    : await scoped.visits.uniqueCount({ fileId, metric, sinceMs });

  // The card-filter dropdown list is fixed per org, not per page: only on the
  // first page (the client holds it across "Load more").
  const cards = cursor ? undefined : await scoped.visits.filterCards();

  return Response.json({
    ok: true,
    rows,
    nextCursor: nextCursor ? `${nextCursor.at}.${nextCursor.id}` : null,
    uniqueVisitors,
    cards,
  });
}
