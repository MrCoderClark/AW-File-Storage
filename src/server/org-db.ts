import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import { getDb, type Db } from "./db";
import {
  auditEvents,
  files,
  fileVersions,
  uploadSessions,
} from "./db/schema";

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

  return { orgId, files: files_, versions, uploads, audit };
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
