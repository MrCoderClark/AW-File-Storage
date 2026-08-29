import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { getDb } from "./db";
import { user } from "./db/auth-schema";
import * as schema from "./db/schema";
import { getActor } from "./session";

export interface StorageUsage {
  usedBytes: number;
  quotaBytes: number;
  pct: number; // 0–100, rounded
}

export interface UploadHistory {
  count: number; // files added today (this org)
  bytes: number; // their total size
}

export interface ActivityEvent {
  id: string;
  action: string;
  summary: string; // human-readable, e.g. "Published a contact card"
  actorName: string; // "" when the actor is unknown/system
  createdAt: string; // ISO
}

export interface RailData {
  usage: StorageUsage;
  history: UploadHistory;
  activity: ActivityEvent[];
}

// Maps an audit action to a short human sentence for Recent Activity (AC-11).
const ACTION_SUMMARY: Record<string, string> = {
  "vcard.published": "Published a contact card",
  "vcard.unpublished": "Unpublished a contact card",
  "file.deleted": "Deleted a file",
  "file.link_created": "Created a download link",
  "file.uploaded": "Uploaded a file",
  "member.invited": "Invited a member",
  "member.invite_revoked": "Revoked an invitation",
  "member.invite_resent": "Resent an invitation",
  "member.joined": "A member joined",
  "member.role_changed": "Changed a member's role",
  "member.suspended": "Suspended a member",
  "member.reactivated": "Reactivated a member",
  "member.removed": "Removed a member",
  "member.sessions_revoked": "Revoked a member's sessions",
  "member.two_factor_reset": "Reset a member's two-factor",
  "member.two_factor_required": "Required two-factor for a member",
  "member.two_factor_optional": "Made two-factor optional for a member",
  "member.password_set": "Set a member's password",
  "member.password_reset_sent": "Sent a password reset link",
};

export function summarizeAction(action: string): string {
  return ACTION_SUMMARY[action] ?? action.replace(/[._]/g, " ");
}

function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/**
 * Everything the left rail needs: storage usage, today's upload history, and the
 * recent activity the caller is allowed to see. Recent Activity is org-wide for
 * owners/admins and own-only for members (spec 0004 AC-11). Returns null when
 * there is no session or no active organization.
 */
export async function getRailData(): Promise<RailData | null> {
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

  const [hist] = await db
    .select({
      count: sql<number>`count(*)`,
      bytes: sql<number>`coalesce(sum(${schema.files.sizeBytes}), 0)`,
    })
    .from(schema.files)
    .where(
      and(
        eq(schema.files.orgId, orgId),
        isNull(schema.files.deletedAt),
        gte(schema.files.createdAt, startOfTodayUtc()),
      ),
    );

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
    .limit(8);

  return {
    usage: { usedBytes, quotaBytes, pct },
    history: { count: Number(hist?.count ?? 0), bytes: Number(hist?.bytes ?? 0) },
    activity: activityRows.map((r) => ({
      id: r.id,
      action: r.action,
      summary: summarizeAction(r.action),
      actorName: r.actorName ?? "",
      createdAt: new Date(r.createdAt).toISOString(),
    })),
  };
}
