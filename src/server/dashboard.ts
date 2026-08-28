import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { getDb } from "./db";
import { member, user } from "./db/auth-schema";
import * as schema from "./db/schema";
import { type ActivityEvent, summarizeAction } from "./rail";
import { getActor } from "./session";

export interface DayPoint {
  date: string; // ISO date (YYYY-MM-DD)
  count: number;
  bytes: number;
}

export interface DashboardData {
  usage: { usedBytes: number; quotaBytes: number; pct: number };
  today: { count: number; bytes: number };
  memberCount: number;
  totals: { files: number; published: number };
  distribution: {
    publishedVcards: number;
    privateVcards: number;
    other: number;
  };
  uploadsByDay: DayPoint[]; // last 30 days, oldest → newest
  activity: ActivityEvent[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfTodayUtc(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/**
 * The richer Dashboard overview (matches docs/Designs/mock-dashboard.jpg). Every
 * figure is real org data — no invented metrics: "team members" is the member
 * count, the traffic chart is uploads per day, the distribution is file kinds.
 * Recent Activity is role-scoped exactly like the rail (spec 0004 AC-11).
 * Returns null with no session / active org.
 */
export async function getDashboardData(): Promise<DashboardData | null> {
  const actor = await getActor();
  if (!actor) return null;
  const db = getDb();
  const { orgId, userId, canManageAny } = actor;

  const [org] = await db
    .select({
      used: schema.organization.storageUsedBytes,
      quota: schema.organization.storageQuotaBytes,
    })
    .from(schema.organization)
    .where(eq(schema.organization.id, orgId))
    .limit(1);
  const usedBytes = org?.used ?? 0;
  const quotaBytes = org?.quota ?? 0;
  const pct = quotaBytes > 0 ? Math.round((usedBytes / quotaBytes) * 100) : 0;

  const [members] = await db
    .select({ n: sql<number>`count(*)` })
    .from(member)
    .where(eq(member.organizationId, orgId));

  // A single pass over the org's live files powers totals, today, the kind
  // distribution, and the 30-day upload trend.
  const rows = await db
    .select({
      createdAt: schema.files.createdAt,
      sizeBytes: schema.files.sizeBytes,
      kind: schema.files.kind,
      visibility: schema.files.visibility,
    })
    .from(schema.files)
    .where(
      and(eq(schema.files.orgId, orgId), isNull(schema.files.deletedAt)),
    );

  const todayStart = startOfTodayUtc();
  const windowStart = todayStart - 29 * DAY_MS; // 30 days including today

  const today = { count: 0, bytes: 0 };
  const distribution = { publishedVcards: 0, privateVcards: 0, other: 0 };
  let published = 0;
  const byDay = new Map<string, { count: number; bytes: number }>();

  for (const r of rows) {
    const t = new Date(r.createdAt).getTime();
    if (t >= todayStart) {
      today.count += 1;
      today.bytes += r.sizeBytes;
    }
    if (r.visibility === "public") published += 1;
    if (r.kind === "vcard") {
      if (r.visibility === "public") distribution.publishedVcards += 1;
      else distribution.privateVcards += 1;
    } else {
      distribution.other += 1;
    }
    if (t >= windowStart) {
      const key = dayKey(new Date(t));
      const cur = byDay.get(key) ?? { count: 0, bytes: 0 };
      cur.count += 1;
      cur.bytes += r.sizeBytes;
      byDay.set(key, cur);
    }
  }

  // Dense 30-day series so the chart has no gaps.
  const uploadsByDay: DayPoint[] = [];
  for (let i = 29; i >= 0; i--) {
    const date = dayKey(new Date(todayStart - i * DAY_MS));
    const v = byDay.get(date) ?? { count: 0, bytes: 0 };
    uploadsByDay.push({ date, count: v.count, bytes: v.bytes });
  }

  const activityRows = await db
    .select({
      id: schema.auditEvents.id,
      action: schema.auditEvents.action,
      createdAt: schema.auditEvents.createdAt,
      actorName: user.name,
    })
    .from(schema.auditEvents)
    .leftJoin(user, eq(schema.auditEvents.actorUserId, user.id))
    .where(
      canManageAny
        ? eq(schema.auditEvents.orgId, orgId)
        : and(
            eq(schema.auditEvents.orgId, orgId),
            eq(schema.auditEvents.actorUserId, userId),
          ),
    )
    .orderBy(desc(schema.auditEvents.createdAt))
    .limit(6);

  return {
    usage: { usedBytes, quotaBytes, pct },
    today,
    memberCount: Number(members?.n ?? 0),
    totals: { files: rows.length, published },
    distribution,
    uploadsByDay,
    activity: activityRows.map((r) => ({
      id: r.id,
      action: r.action,
      summary: summarizeAction(r.action),
      actorName: r.actorName ?? "",
      createdAt: new Date(r.createdAt).toISOString(),
    })),
  };
}
