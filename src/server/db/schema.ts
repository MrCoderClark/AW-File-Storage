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
import { organization, user } from "./auth-schema";

// Re-export Better Auth's tables (user/session/organization/member/invitation/
// twoFactor/...) so the single Drizzle client and the Better Auth adapter share
// one schema object. Better Auth owns these; do not edit auth-schema.ts by hand.
export * from "./auth-schema";

/**
 * This app's own tenant tables (spec 0002). Every one carries a non-null
 * `org_id` referencing Better Auth's `organization`; the org-isolation wrapper
 * (org-db.ts) guarantees no query reaches one without an organization in scope.
 *
 * `uploaded_by` / `actor_user_id` / `deleted_by` reference `user` WITHOUT
 * cascade: a departing user is disabled, never hard-deleted, so history
 * survives (spec 0002). `org_id` cascades, so deleting an organization removes
 * its files, versions, uploads, and audit rows.
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
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    uploadedBy: text("uploaded_by")
      .notNull()
      .references(() => user.id),
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
    deletedBy: text("deleted_by").references(() => user.id),
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
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    fileId: text("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    storageKey: text("storage_key").notNull(),
    uploadedBy: text("uploaded_by")
      .notNull()
      .references(() => user.id),
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
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
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
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => user.id),
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

// Per-state social links for the org's printable signatures (spec 0009 follow-up).
// One row per (org, state); the signature generator resolves a card's state to
// this row, falling back to the built-in defaults in signature-brand.ts. Managed
// from Settings by owners/admins. URLs are nullable so a state can set only some.
export const orgSocialLinks = sqliteTable(
  "org_social_link",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // 2-letter US state abbreviation (e.g. "NY", "CA"); "*" is the org-wide default.
    state: text("state").notNull(),
    facebook: text("facebook"),
    x: text("x"),
    instagram: text("instagram"),
    // Absolute URL of an uploaded per-state logo in the R2 public bucket; null
    // falls back to the built-in logosByState in signature-brand.ts.
    logoUrl: text("logo_url"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("org_social_link_org_state_uq").on(t.orgId, t.state)],
);

// Drives the per-account lockout in spec 0001 (AC-7). Keyed by user id.
export const accountLock = sqliteTable("account_lock", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  failedCount: integer("failed_count").notNull().default(0),
  lockedUntil: integer("locked_until", { mode: "timestamp_ms" }),
  lockLevel: integer("lock_level").notNull().default(0),
});
