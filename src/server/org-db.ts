import { and, desc, eq, gte, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { buildDb, getDb, type Db } from "./db";
import {
  auditEvents,
  cardStatDaily,
  files,
  fileVersions,
  orgSettings,
  orgSocialLinks,
  uploadSessions,
} from "./db/schema";
import { uuidv7 } from "./id";

/**
 * Thrown when a tenant-table operation is attempted with no organization in
 * scope. This is deliberately a throw, not a silent empty result: a missing
 * organization is a bug, and it must fail loudly rather than quietly returning
 * or writing the wrong rows (spec 0002, AC-2).
 */
export class OrgScopeError extends Error {
  constructor(
    message = "No organization in scope for a tenant-table operation",
  ) {
    super(message);
    this.name = "OrgScopeError";
  }
}

function assertOrg(orgId: string): void {
  if (typeof orgId !== "string" || orgId.trim() === "") {
    throw new OrgScopeError();
  }
}

// Insert shapes with org_id removed — the wrapper injects it, so a caller can
// neither forget it nor set it to the wrong organization.
type NewFile = Omit<typeof files.$inferInsert, "orgId">;
type NewFileVersion = Omit<typeof fileVersions.$inferInsert, "orgId">;
type NewUploadSession = Omit<typeof uploadSessions.$inferInsert, "orgId">;
type NewAuditEvent = Omit<typeof auditEvents.$inferInsert, "orgId">;

/**
 * The ONLY way feature code reaches tenant data. Every method here constrains
 * to `orgId`, so an organization filter cannot be forgotten: the unsafe query
 * is not merely discouraged, it cannot be written through this surface. The raw
 * Drizzle client is never returned.
 *
 * `orgId` comes from `session.activeOrganizationId` (Better Auth), never from
 * anything the browser supplied. `db` defaults to the request's client but can
 * be injected in tests.
 */
export function orgDb(orgId: string, db: Db = getDb()) {
  assertOrg(orgId);

  const files_ = {
    async create(data: NewFile) {
      const rows = await db
        .insert(files)
        .values({ ...data, orgId })
        .returning();
      return rows[0];
    },
    /** A file by id, only if it belongs to this org (else undefined -> caller returns 404). */
    async get(id: string) {
      const rows = await db
        .select()
        .from(files)
        .where(and(eq(files.orgId, orgId), eq(files.id, id)));
      return rows[0];
    },
    /** Live (not soft-deleted) files for this org, newest first. */
    async listActive() {
      return db
        .select()
        .from(files)
        .where(and(eq(files.orgId, orgId), isNull(files.deletedAt)))
        .orderBy(desc(files.createdAt));
    },
    async update(id: string, patch: Partial<NewFile>) {
      const rows = await db
        .update(files)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(files.orgId, orgId), eq(files.id, id)))
        .returning();
      return rows[0];
    },
    /** Soft delete: the row stays, leaves every listing, keeps who/when (AC-7 of 0002). */
    async softDelete(id: string, deletedBy: string) {
      const rows = await db
        .update(files)
        .set({ deletedAt: new Date(), deletedBy, updatedAt: new Date() })
        .where(and(eq(files.orgId, orgId), eq(files.id, id)))
        .returning();
      return rows[0];
    },
  };

  const versions = {
    async create(data: NewFileVersion) {
      const rows = await db
        .insert(fileVersions)
        .values({ ...data, orgId })
        .returning();
      return rows[0];
    },
    async listForFile(fileId: string) {
      return db
        .select()
        .from(fileVersions)
        .where(
          and(eq(fileVersions.orgId, orgId), eq(fileVersions.fileId, fileId)),
        )
        .orderBy(desc(fileVersions.version));
    },
  };

  const uploads = {
    async create(data: NewUploadSession) {
      const rows = await db
        .insert(uploadSessions)
        .values({ ...data, orgId })
        .returning();
      return rows[0];
    },
    async get(id: string) {
      const rows = await db
        .select()
        .from(uploadSessions)
        .where(
          and(eq(uploadSessions.orgId, orgId), eq(uploadSessions.id, id)),
        );
      return rows[0];
    },
    async markComplete(id: string) {
      const rows = await db
        .update(uploadSessions)
        .set({ completedAt: new Date() })
        .where(and(eq(uploadSessions.orgId, orgId), eq(uploadSessions.id, id)))
        .returning();
      return rows[0];
    },
  };

  const audit = {
    /** Insert-only. There is intentionally no update or delete here (AC-8 of 0002). */
    async append(event: NewAuditEvent) {
      const rows = await db
        .insert(auditEvents)
        .values({ ...event, orgId })
        .returning();
      return rows[0];
    },
    async list(opts: { limit?: number } = {}) {
      return db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.orgId, orgId))
        .orderBy(desc(auditEvents.createdAt))
        .limit(opts.limit ?? 100);
    },
  };

  // Per-org settings (spec 0012). A missing row reads as the defaults; writes
  // upsert the single row for this org. Constrained to `orgId` like every other
  // helper here, so one org can never read or change another's settings.
  const settings = {
    async get(): Promise<{ o365SyncEnabled: boolean }> {
      const rows = await db
        .select({ o365SyncEnabled: orgSettings.o365SyncEnabled })
        .from(orgSettings)
        .where(eq(orgSettings.orgId, orgId))
        .limit(1);
      return { o365SyncEnabled: rows[0]?.o365SyncEnabled ?? false };
    },
    async setO365SyncEnabled(value: boolean) {
      await db
        .insert(orgSettings)
        .values({ orgId, o365SyncEnabled: value, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: orgSettings.orgId,
          set: { o365SyncEnabled: value, updatedAt: new Date() },
        });
    },
  };

  // Per-state social links for signatures/landing pages (spec 0009). Owns only
  // the org-scoped DB access; the R2 logo orchestration + brand fallback stay in
  // social-links.ts, which calls these. Returns full rows so the caller can pick
  // whatever columns it needs.
  const socialLinks = {
    /** Every state row for this org, ordered by state. */
    async list() {
      return db
        .select()
        .from(orgSocialLinks)
        .where(eq(orgSocialLinks.orgId, orgId))
        .orderBy(orgSocialLinks.state);
    },
    /** Rows for the given states (e.g. an exact state plus the "*" default). */
    async forStates(states: string[]) {
      if (states.length === 0) return [];
      return db
        .select()
        .from(orgSocialLinks)
        .where(
          and(
            eq(orgSocialLinks.orgId, orgId),
            inArray(orgSocialLinks.state, states),
          ),
        );
    },
    /** Upsert the social URLs on a state's row (leaves the logo untouched). */
    async upsertSocials(
      state: string,
      v: {
        facebook: string | null;
        x: string | null;
        instagram: string | null;
      },
    ) {
      const now = new Date();
      await db
        .insert(orgSocialLinks)
        .values({ id: uuidv7(), orgId, state, ...v, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: [orgSocialLinks.orgId, orgSocialLinks.state],
          set: { ...v, updatedAt: now },
        });
    },
    /** Upsert just the logo URL on a state's row (leaves the socials untouched). */
    async setLogoUrl(state: string, logoUrl: string | null) {
      const now = new Date();
      await db
        .insert(orgSocialLinks)
        .values({ id: uuidv7(), orgId, state, logoUrl, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: [orgSocialLinks.orgId, orgSocialLinks.state],
          set: { logoUrl, updatedAt: now },
        });
    },
    async remove(state: string) {
      await db
        .delete(orgSocialLinks)
        .where(
          and(eq(orgSocialLinks.orgId, orgId), eq(orgSocialLinks.state, state)),
        );
    },
  };

  // Per-card engagement rollup (spec 0008). Owns only the org-scoped SQL (each
  // read constrained to this org; the top/engagement joins to `file` stay inside
  // the org too); the aggregation/shaping into totals + series stays in
  // card-stats.ts, which calls these.
  const cardStats = {
    /** Bump the (file, day, metric) counter by one (atomic upsert). */
    async recordHit(fileId: string, date: string, metric: CardMetric) {
      await db
        .insert(cardStatDaily)
        .values({ orgId, fileId, date, metric, count: 1 })
        .onConflictDoUpdate({
          target: [cardStatDaily.fileId, cardStatDaily.date, cardStatDaily.metric],
          set: { count: sql`${cardStatDaily.count} + 1` },
        });
    },
    /** Per-file totals for a set of file ids: sum + last day, grouped. */
    async totalsForFiles(fileIds: string[]) {
      if (fileIds.length === 0) {
        return [] as {
          fileId: string;
          metric: string;
          total: number;
          lastDate: string;
        }[];
      }
      return db
        .select({
          fileId: cardStatDaily.fileId,
          metric: cardStatDaily.metric,
          total: sql<number>`sum(${cardStatDaily.count})`,
          lastDate: sql<string>`max(${cardStatDaily.date})`,
        })
        .from(cardStatDaily)
        .where(
          and(
            eq(cardStatDaily.orgId, orgId),
            inArray(cardStatDaily.fileId, fileIds),
          ),
        )
        .groupBy(cardStatDaily.fileId, cardStatDaily.metric);
    },
    /** Daily (date, metric) sums for one card within a window. */
    async detailRows(fileId: string, since: string) {
      return db
        .select({
          date: cardStatDaily.date,
          metric: cardStatDaily.metric,
          total: sql<number>`sum(${cardStatDaily.count})`,
        })
        .from(cardStatDaily)
        .where(
          and(
            eq(cardStatDaily.orgId, orgId),
            eq(cardStatDaily.fileId, fileId),
            gte(cardStatDaily.date, since),
          ),
        )
        .groupBy(cardStatDaily.date, cardStatDaily.metric);
    },
    /** Org-wide daily (date, metric) sums, optionally scoped to one uploader. */
    async engagementRows(opts: { since: string; uploaderUserId?: string }) {
      const scope = and(
        eq(cardStatDaily.orgId, orgId),
        gte(cardStatDaily.date, opts.since),
        opts.uploaderUserId ? eq(files.uploadedBy, opts.uploaderUserId) : undefined,
      );
      const cols = {
        date: cardStatDaily.date,
        metric: cardStatDaily.metric,
        total: sql<number>`sum(${cardStatDaily.count})`,
      };
      if (opts.uploaderUserId) {
        return db
          .select(cols)
          .from(cardStatDaily)
          .innerJoin(files, eq(files.id, cardStatDaily.fileId))
          .where(scope)
          .groupBy(cardStatDaily.date, cardStatDaily.metric);
      }
      return db
        .select(cols)
        .from(cardStatDaily)
        .where(scope)
        .groupBy(cardStatDaily.date, cardStatDaily.metric);
    },
    /** Highest-engagement cards (name + slug + per-metric sums), most hits first. */
    async topCards(opts: {
      since: string;
      uploaderUserId?: string;
      limit: number;
    }) {
      const scope = and(
        eq(cardStatDaily.orgId, orgId),
        gte(cardStatDaily.date, opts.since),
        opts.uploaderUserId ? eq(files.uploadedBy, opts.uploaderUserId) : undefined,
      );
      return db
        .select({
          fileId: cardStatDaily.fileId,
          name: files.originalName,
          slug: files.publicSlug,
          views: sql<number>`sum(case when ${cardStatDaily.metric} = 'view' then ${cardStatDaily.count} else 0 end)`,
          scans: sql<number>`sum(case when ${cardStatDaily.metric} = 'scan' then ${cardStatDaily.count} else 0 end)`,
          downloads: sql<number>`sum(case when ${cardStatDaily.metric} = 'download' then ${cardStatDaily.count} else 0 end)`,
        })
        .from(cardStatDaily)
        .innerJoin(files, eq(files.id, cardStatDaily.fileId))
        .where(scope)
        .groupBy(cardStatDaily.fileId, files.originalName, files.publicSlug)
        .orderBy(desc(sql`sum(${cardStatDaily.count})`))
        .limit(opts.limit);
    },
  };

  return {
    orgId,
    files: files_,
    versions,
    uploads,
    audit,
    settings,
    socialLinks,
    cardStats,
  };
}

/** The metric values counted per card (spec 0008). */
export type CardMetric = "view" | "scan" | "download";

/**
 * Build an org-scoped client straight from a D1 binding, for the modules that
 * own complex queries over a tenant table (card stats, social links) and receive
 * an `env` rather than running inside the request's ambient client. Keeps those
 * modules off the raw `./db` import — they reach tenant data only through here.
 */
export function orgDbFor(orgId: string, d1: D1Database): OrgDb {
  return orgDb(orgId, buildDb(d1));
}

export type OrgDb = ReturnType<typeof orgDb>;

/**
 * A tenant row that exists but belongs to another organization is reported the
 * same as one that does not exist, so the API cannot be used to discover what
 * exists elsewhere (spec 0002, AC-3). Callers use this when a scoped `get`
 * returns undefined.
 */
export function notFound(): never {
  const err = new Error("Not found");
  err.name = "NotFoundError";
  throw err;
}
