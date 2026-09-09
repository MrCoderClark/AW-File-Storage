import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNull,
  like,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { buildDb, getDb, type Db } from "./db";
import {
  auditEvents,
  cardStatDaily,
  files,
  fileVersions,
  helpArticles,
  helpCategories,
  helpImages,
  member,
  orgO365,
  orgSettings,
  orgSocialLinks,
  uploadSessions,
  user,
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
type NewHelpArticle = Omit<typeof helpArticles.$inferInsert, "orgId">;
type NewHelpImage = Omit<typeof helpImages.$inferInsert, "orgId">;
type NewHelpCategory = Omit<typeof helpCategories.$inferInsert, "orgId">;

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
    /**
     * The admin Activity Logs feed (spec 0018): filtered, keyset-paginated, with the
     * actor's name joined. Cursor is [createdAt-ms, id] for a stable desc order.
     */
    async listPage(opts: {
      sinceMs?: number;
      actions?: string[];
      q?: string;
      cursor?: { at: number; id: string } | null;
      limit?: number;
    }) {
      const limit = Math.min(opts.limit ?? 40, 100);
      const conds: SQL[] = [eq(auditEvents.orgId, orgId)];
      if (opts.sinceMs) {
        conds.push(gte(auditEvents.createdAt, new Date(opts.sinceMs)));
      }
      if (opts.actions?.length) {
        conds.push(inArray(auditEvents.action, opts.actions));
      }
      if (opts.q?.trim()) {
        const pat = `%${opts.q.trim()}%`;
        const m = or(
          like(auditEvents.action, pat),
          like(auditEvents.targetId, pat),
          like(auditEvents.metadataJson, pat),
          like(user.name, pat),
        );
        if (m) conds.push(m);
      }
      if (opts.cursor) {
        const at = new Date(opts.cursor.at);
        // (createdAt, id) strictly before the cursor, for a desc keyset page.
        const c = or(
          lt(auditEvents.createdAt, at),
          and(eq(auditEvents.createdAt, at), lt(auditEvents.id, opts.cursor.id)),
        );
        if (c) conds.push(c);
      }
      const rows = await db
        .select({
          id: auditEvents.id,
          action: auditEvents.action,
          targetType: auditEvents.targetType,
          targetId: auditEvents.targetId,
          metadataJson: auditEvents.metadataJson,
          createdAt: auditEvents.createdAt,
          actorId: auditEvents.actorUserId,
          actorName: user.name,
        })
        .from(auditEvents)
        .leftJoin(user, eq(user.id, auditEvents.actorUserId))
        .where(and(...conds))
        .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit);

      // Resolve each event's target id to a human name (a card's contact, a member's
      // person, a user), so the log shows "Sarah K." instead of a raw UUID.
      const labels = new Map<string, string>();
      const idsOf = (type: string) =>
        items
          .filter((i) => i.targetType === type && i.targetId)
          .map((i) => i.targetId as string);
      const fileIds = idsOf("file");
      const memberIds = idsOf("member");
      const userIds = idsOf("user");
      if (fileIds.length) {
        const fs = await db
          .select({ id: files.id, name: files.contactName, orig: files.originalName })
          .from(files)
          .where(and(eq(files.orgId, orgId), inArray(files.id, fileIds)));
        for (const f of fs) labels.set(f.id, f.name || f.orig);
      }
      if (memberIds.length) {
        const ms = await db
          .select({ id: member.id, name: user.name, email: user.email })
          .from(member)
          .leftJoin(user, eq(user.id, member.userId))
          .where(
            and(eq(member.organizationId, orgId), inArray(member.id, memberIds)),
          );
        for (const m of ms) labels.set(m.id, m.name || m.email || m.id);
      }
      if (userIds.length) {
        const us = await db
          .select({ id: user.id, name: user.name, email: user.email })
          .from(user)
          .where(inArray(user.id, userIds));
        for (const u of us) labels.set(u.id, u.name || u.email);
      }

      const withLabels = items.map((i) => ({
        ...i,
        targetLabel: i.targetId ? (labels.get(i.targetId) ?? null) : null,
      }));
      const last = items[items.length - 1];
      return {
        items: withLabels,
        nextCursor:
          hasMore && last ? { at: last.createdAt.getTime(), id: last.id } : null,
      };
    },
    /** Header stats for the Activity Logs view (spec 0018). */
    async stats(): Promise<{
      totalToday: number;
      o365SuccessRate: number;
      activeVcards: number;
    }> {
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const [today] = await db
        .select({ n: count() })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.orgId, orgId),
            gte(auditEvents.createdAt, startOfToday),
          ),
        );
      const o365 = await db
        .select({ action: auditEvents.action, n: count() })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.orgId, orgId),
            inArray(auditEvents.action, [
              "o365.synced",
              "o365.cleared",
              "o365.sync_failed",
            ]),
          ),
        )
        .groupBy(auditEvents.action);
      let ok = 0;
      let bad = 0;
      for (const r of o365) {
        if (r.action === "o365.sync_failed") bad += Number(r.n);
        else ok += Number(r.n);
      }
      const [vc] = await db
        .select({ n: count() })
        .from(files)
        .where(
          and(
            eq(files.orgId, orgId),
            eq(files.kind, "vcard"),
            eq(files.visibility, "public"),
            isNull(files.deletedAt),
          ),
        );
      return {
        totalToday: Number(today?.n ?? 0),
        o365SuccessRate: ok + bad > 0 ? ok / (ok + bad) : 1,
        activeVcards: Number(vc?.n ?? 0),
      };
    },
  };

  // Per-org settings (spec 0012). A missing row reads as the defaults; writes
  // upsert the single row for this org. Constrained to `orgId` like every other
  // helper here, so one org can never read or change another's settings.
  const settings = {
    async get(): Promise<{
      o365SyncEnabled: boolean;
      o365AutoCardEnabled: boolean;
      o365AutoCardSince: Date | null;
      o365RemoveOnOffboardEnabled: boolean;
    }> {
      const rows = await db
        .select({
          o365SyncEnabled: orgSettings.o365SyncEnabled,
          o365AutoCardEnabled: orgSettings.o365AutoCardEnabled,
          o365AutoCardSince: orgSettings.o365AutoCardSince,
          o365RemoveOnOffboardEnabled: orgSettings.o365RemoveOnOffboardEnabled,
        })
        .from(orgSettings)
        .where(eq(orgSettings.orgId, orgId))
        .limit(1);
      return {
        o365SyncEnabled: rows[0]?.o365SyncEnabled ?? false,
        o365AutoCardEnabled: rows[0]?.o365AutoCardEnabled ?? false,
        o365AutoCardSince: rows[0]?.o365AutoCardSince ?? null,
        o365RemoveOnOffboardEnabled:
          rows[0]?.o365RemoveOnOffboardEnabled ?? false,
      };
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
    async setO365AutoCardEnabled(value: boolean) {
      const now = new Date();
      // Stamp the cutoff each time the feature is turned ON, so only users created
      // after this moment are provisioned (existing staff are never backfilled).
      // Turning it off leaves the previous cutoff untouched.
      await db
        .insert(orgSettings)
        .values({
          orgId,
          o365AutoCardEnabled: value,
          o365AutoCardSince: value ? now : null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: orgSettings.orgId,
          set: value
            ? { o365AutoCardEnabled: true, o365AutoCardSince: now, updatedAt: now }
            : { o365AutoCardEnabled: false, updatedAt: now },
        });
    },
    async setO365RemoveOnOffboardEnabled(value: boolean) {
      const now = new Date();
      await db
        .insert(orgSettings)
        .values({ orgId, o365RemoveOnOffboardEnabled: value, updatedAt: now })
        .onConflictDoUpdate({
          target: orgSettings.orgId,
          set: { o365RemoveOnOffboardEnabled: value, updatedAt: now },
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
          pdfs: sql<number>`sum(case when ${cardStatDaily.metric} = 'pdf' then ${cardStatDaily.count} else 0 end)`,
        })
        .from(cardStatDaily)
        .innerJoin(files, eq(files.id, cardStatDaily.fileId))
        .where(scope)
        .groupBy(cardStatDaily.fileId, files.originalName, files.publicSlug)
        .orderBy(desc(sql`sum(${cardStatDaily.count})`))
        .limit(opts.limit);
    },
  };

  // Per-org Office 365 credentials (spec 0013). Stores/returns the ENCRYPTED row
  // as-is — encryption/decryption happens in the O365 layer, so the KEK never
  // reaches this wrapper. Org-scoped like every other helper: one org can't read
  // or overwrite another's credentials.
  const graphCreds = {
    async get() {
      const rows = await db
        .select()
        .from(orgO365)
        .where(eq(orgO365.orgId, orgId))
        .limit(1);
      return rows[0];
    },
    async set(data: Omit<typeof orgO365.$inferInsert, "orgId">) {
      await db
        .insert(orgO365)
        .values({ ...data, orgId })
        .onConflictDoUpdate({
          target: orgO365.orgId,
          set: { ...data, updatedAt: new Date() },
        });
    },
    async clear() {
      await db.delete(orgO365).where(eq(orgO365.orgId, orgId));
    },
  };

  // In-app help & documentation CMS (spec 0024). Writes stay strictly org-scoped (the
  // caller's own org). The ONLY cross-org reads live here and are deliberate: `listForReader`
  // (own-org published PLUS shared published from any org) and `getServableImage` (own-org, or
  // an image referenced by a published+shared article). Both are covered by an isolation test.
  // NOTE: this breaks the "every method constrains to orgId" claim in the file header comment
  // above; these two reads are the sanctioned exception.
  const help = {
    /** Reader feed (spec 0024 AC-4, spec 0025 audience): this org's published articles plus
     * every org's shared published articles. The one cross-org read for articles. When the
     * viewer is NOT an admin/owner, `admins`-audience articles are excluded server-side. */
    async listForReader({ viewerIsAdmin = false }: { viewerIsAdmin?: boolean } = {}) {
      return db
        .select({
          id: helpArticles.id,
          title: helpArticles.title,
          // Resolve the effective category: the joined category name when the article
          // points at one (its category may live in another org for a shared article, so
          // the join is on id alone), else the deprecated free-text `category`.
          category: sql<string>`coalesce(${helpCategories.name}, ${helpArticles.category})`,
          categoryId: helpArticles.categoryId,
          excerpt: helpArticles.excerpt,
          pageKey: helpArticles.pageKey,
          audience: helpArticles.audience,
          sortOrder: helpArticles.sortOrder,
          updatedAt: helpArticles.updatedAt,
        })
        .from(helpArticles)
        .leftJoin(
          helpCategories,
          eq(helpCategories.id, helpArticles.categoryId),
        )
        .where(
          and(
            eq(helpArticles.status, "published"),
            or(eq(helpArticles.orgId, orgId), eq(helpArticles.shared, true)),
            viewerIsAdmin ? undefined : eq(helpArticles.audience, "all"),
          ),
        )
        .orderBy(
          helpArticles.sortOrder,
          helpArticles.title,
        );
    },
    /** One published article a reader in this org may see (own or shared), by id. An
     * `admins`-audience article is withheld from a non-admin viewer (spec 0025). */
    async getForReader(articleId: string, viewerIsAdmin = false) {
      const rows = await db
        .select({
          ...getTableColumns(helpArticles),
          // Effective category name (joined by id, cross-org safe for shared articles),
          // falling back to the deprecated free-text `category`.
          category: sql<string>`coalesce(${helpCategories.name}, ${helpArticles.category})`,
        })
        .from(helpArticles)
        .leftJoin(
          helpCategories,
          eq(helpCategories.id, helpArticles.categoryId),
        )
        .where(
          and(
            eq(helpArticles.id, articleId),
            eq(helpArticles.status, "published"),
            or(eq(helpArticles.orgId, orgId), eq(helpArticles.shared, true)),
            viewerIsAdmin ? undefined : eq(helpArticles.audience, "all"),
          ),
        )
        .limit(1);
      return rows[0];
    },
    /** Resolve related-article ids to reader-visible `{ id, title, category }` (spec 0025 AC-5).
     * Reuses the reader visibility union (published, own-or-shared, audience-gated) so dangling
     * or not-visible ids simply drop out. Order is restored to `ids` by the caller. */
    async listRelatedForReader(ids: string[], viewerIsAdmin = false) {
      if (ids.length === 0) return [];
      return db
        .select({
          id: helpArticles.id,
          title: helpArticles.title,
          category: sql<string>`coalesce(${helpCategories.name}, ${helpArticles.category})`,
        })
        .from(helpArticles)
        .leftJoin(
          helpCategories,
          eq(helpCategories.id, helpArticles.categoryId),
        )
        .where(
          and(
            inArray(helpArticles.id, ids),
            eq(helpArticles.status, "published"),
            or(eq(helpArticles.orgId, orgId), eq(helpArticles.shared, true)),
            viewerIsAdmin ? undefined : eq(helpArticles.audience, "all"),
          ),
        );
    },
    /** Admin list of THIS org's own articles, any status (for the editor, slice 2). */
    async listOwn() {
      return db
        .select()
        .from(helpArticles)
        .where(eq(helpArticles.orgId, orgId))
        .orderBy(helpArticles.category, helpArticles.sortOrder);
    },
    /** One of THIS org's own articles by id (any status). */
    async getOwn(articleId: string) {
      const rows = await db
        .select()
        .from(helpArticles)
        .where(and(eq(helpArticles.orgId, orgId), eq(helpArticles.id, articleId)))
        .limit(1);
      return rows[0];
    },
    async create(data: NewHelpArticle) {
      const rows = await db
        .insert(helpArticles)
        .values({ ...data, orgId })
        .returning();
      return rows[0];
    },
    async update(articleId: string, patch: Partial<NewHelpArticle>) {
      const rows = await db
        .update(helpArticles)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(helpArticles.orgId, orgId), eq(helpArticles.id, articleId)))
        .returning();
      return rows[0];
    },
    async remove(articleId: string) {
      await db
        .delete(helpArticles)
        .where(and(eq(helpArticles.orgId, orgId), eq(helpArticles.id, articleId)));
    },
    async createImage(data: NewHelpImage) {
      const rows = await db
        .insert(helpImages)
        .values({ ...data, orgId })
        .returning();
      return rows[0];
    },
    /** Link this org's images to an article (spec 0024 AC-7), so a shared article's images
     * resolve cross-org and orphans can be swept. Own-org only; call on article save. */
    async linkImages(articleId: string, imageIds: string[]) {
      if (imageIds.length === 0) return;
      await db
        .update(helpImages)
        .set({ articleId })
        .where(
          and(eq(helpImages.orgId, orgId), inArray(helpImages.id, imageIds)),
        );
    },
    /** Authorize an image serve (spec 0024 AC-7): return the image only if it belongs to this
     * org, OR it is referenced by a currently published + shared article. Else undefined. */
    async getServableImage(imageId: string) {
      const [img] = await db
        .select({
          id: helpImages.id,
          r2Key: helpImages.r2Key,
          contentType: helpImages.contentType,
          imageOrgId: helpImages.orgId,
          articleId: helpImages.articleId,
        })
        .from(helpImages)
        .where(eq(helpImages.id, imageId))
        .limit(1);
      if (!img) return undefined;
      if (img.imageOrgId === orgId) return img; // own org
      if (!img.articleId) return undefined;
      const [shared] = await db
        .select({ id: helpArticles.id })
        .from(helpArticles)
        .where(
          and(
            eq(helpArticles.id, img.articleId),
            eq(helpArticles.status, "published"),
            eq(helpArticles.shared, true),
          ),
        )
        .limit(1);
      return shared ? img : undefined;
    },
    // --- Categories (spec 0025): a per-org, nestable list. All org-scoped. ---
    async listCategories() {
      return db
        .select()
        .from(helpCategories)
        .where(eq(helpCategories.orgId, orgId))
        .orderBy(helpCategories.sortOrder, helpCategories.name);
    },
    async getCategory(categoryId: string) {
      const rows = await db
        .select()
        .from(helpCategories)
        .where(
          and(eq(helpCategories.orgId, orgId), eq(helpCategories.id, categoryId)),
        )
        .limit(1);
      return rows[0];
    },
    async createCategory(data: NewHelpCategory) {
      const rows = await db
        .insert(helpCategories)
        .values({ ...data, orgId })
        .returning();
      return rows[0];
    },
    async updateCategory(categoryId: string, patch: Partial<NewHelpCategory>) {
      const rows = await db
        .update(helpCategories)
        .set({ ...patch, updatedAt: new Date() })
        .where(
          and(eq(helpCategories.orgId, orgId), eq(helpCategories.id, categoryId)),
        )
        .returning();
      return rows[0];
    },
    /** Delete a category: reparent its children to top-level and clear it off any article
     * first (both org-scoped), so no article or child points at a gone category. */
    async removeCategory(categoryId: string) {
      await db
        .update(helpCategories)
        .set({ parentId: null })
        .where(
          and(
            eq(helpCategories.orgId, orgId),
            eq(helpCategories.parentId, categoryId),
          ),
        );
      await db
        .update(helpArticles)
        .set({ categoryId: null })
        .where(
          and(
            eq(helpArticles.orgId, orgId),
            eq(helpArticles.categoryId, categoryId),
          ),
        );
      await db
        .delete(helpCategories)
        .where(
          and(eq(helpCategories.orgId, orgId), eq(helpCategories.id, categoryId)),
        );
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
    graphCreds,
    help,
  };
}

/**
 * The metric values counted per card (spec 0008). "download" is the `.vcf`
 * ("Add to contacts"); "pdf" is the `.pdf` save, counted separately so neither
 * number changes meaning. Mirrored by the CHECK on `card_stat_daily.metric`.
 */
export type CardMetric = "view" | "scan" | "download" | "pdf";

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
