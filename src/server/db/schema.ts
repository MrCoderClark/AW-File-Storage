import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { uuidv7 } from "../id";

/**
 * This app's own tenant tables (spec 0002). Every one carries a non-null
 * `org_id`; the org-isolation wrapper (org-db.ts) guarantees no query reaches
 * one without an organization in scope.
 *
 * FOREIGN KEYS TO AUTH TABLES ARE DEFERRED: `org_id`, `uploaded_by`, `user_id`,
 * `actor_user_id`, and `deleted_by` reference Better Auth's `organization` and
 * `user` tables, which land in Phase 2 (spec 0001). They are plain text columns
 * here; the FK constraints are added in the Phase 2 migration once those tables
 * exist. Intra-app references (a version/upload -> its file) are enforced now.
 */

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => uuidv7());

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());

const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());

export const files = sqliteTable(
  "file",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    uploadedBy: text("uploaded_by").notNull(),
    originalName: text("original_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    storageKey: text("storage_key").notNull(),
    bucket: text("bucket", { enum: ["private", "public"] }).notNull(),
    visibility: text("visibility", { enum: ["private", "public"] }).notNull(),
    kind: text("kind", { enum: ["vcard", "other"] }).notNull(),
    status: text("status", {
      enum: ["pending", "uploading", "validating", "ready", "failed"],
    }).notNull(),
    failureReason: text("failure_reason"),
    publicSlug: text("public_slug"),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    deletedBy: text("deleted_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("file_org_deleted_created_idx").on(t.orgId, t.deletedAt, t.createdAt),
    index("file_org_kind_idx").on(t.orgId, t.kind),
    // Global uniqueness: a public slug is a path on one shared public domain.
    uniqueIndex("file_public_slug_uq").on(t.publicSlug),
    // One live copy of a given file per org (ignores soft-deleted rows).
    uniqueIndex("file_org_checksum_uq")
      .on(t.orgId, t.checksumSha256)
      .where(sql`${t.deletedAt} is null`),
    check("file_bucket_ck", sql`${t.bucket} in ('private','public')`),
    check("file_visibility_ck", sql`${t.visibility} in ('private','public')`),
    check("file_kind_ck", sql`${t.kind} in ('vcard','other')`),
    check(
      "file_status_ck",
      sql`${t.status} in ('pending','uploading','validating','ready','failed')`,
    ),
  ],
);

export const fileVersions = sqliteTable(
  "file_version",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    fileId: text("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    storageKey: text("storage_key").notNull(),
    uploadedBy: text("uploaded_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("file_version_file_version_uq").on(t.fileId, t.version),
    index("file_version_org_file_idx").on(t.orgId, t.fileId),
  ],
);

export const uploadSessions = sqliteTable(
  "upload_session",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    fileId: text("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    stagingKey: text("staging_key").notNull(),
    declaredSizeBytes: integer("declared_size_bytes").notNull(),
    declaredContentType: text("declared_content_type").notNull(),
    multipartUploadId: text("multipart_upload_id"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [index("upload_session_org_expires_idx").on(t.orgId, t.expiresAt)],
);

// Insert-only. No update or delete path exists in application code (spec 0002, AC-8).
export const auditEvents = sqliteTable(
  "audit_event",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    actorUserId: text("actor_user_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    metadataJson: text("metadata_json"),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_event_org_created_idx").on(t.orgId, t.createdAt),
    index("audit_event_org_target_idx").on(t.orgId, t.targetType, t.targetId),
  ],
);

// Drives the per-account lockout in spec 0001 (AC-7). Keyed by user id.
export const accountLock = sqliteTable("account_lock", {
  userId: text("user_id").primaryKey(),
  failedCount: integer("failed_count").notNull().default(0),
  lockedUntil: integer("locked_until", { mode: "timestamp_ms" }),
  lockLevel: integer("lock_level").notNull().default(0),
});
