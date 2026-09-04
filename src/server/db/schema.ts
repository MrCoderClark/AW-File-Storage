import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
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
    // Searchable contact fields, denormalised from the vCard at finalize (spec
    // 0003) so the Files list can search by name/company/title/email in SQL —
    // the `.vcf` in R2 stays the source of truth. Null for non-vCard files.
    contactName: text("contact_name"),
    contactOrg: text("contact_org"),
    contactTitle: text("contact_title"),
    contactEmail: text("contact_email"),
    // Searchable location blob: "City StateAbbr StateFullName" (e.g.
    // "Bronx NY New York"), so one search matches city or either state form.
    contactLocation: text("contact_location"),
    // Persisted coarse type (FileCategory in lib/file-type.ts), so the Files
    // "Filter by type" control is an indexable WHERE rather than a client guess.
    category: text("category"),
    // Office 365 sync state (spec 0010): the card's public URL is written into the
    // matched staff member's Exchange CustomAttribute1 via Microsoft Graph. All
    // null until a sync runs; only meaningful for published vCards.
    o365UserId: text("o365_user_id"), // matched Graph user object id, or null
    o365SyncedUrl: text("o365_synced_url"), // value last written (drives idempotent diffing)
    o365SyncedAt: integer("o365_synced_at", { mode: "timestamp_ms" }),
    o365SyncStatus: text("o365_sync_status", {
      enum: ["synced", "cleared", "no_match", "ambiguous", "error"],
    }),
    o365SyncError: text("o365_sync_error"),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    deletedBy: text("deleted_by").references(() => user.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("file_org_deleted_created_idx").on(t.orgId, t.deletedAt, t.createdAt),
    index("file_org_kind_idx").on(t.orgId, t.kind),
    // Keyset pagination + server-side filter/sort access paths for the Files list
    // (spec 0007). Each ends in `id` (the uuidv7 PK, ~created_at) as the cursor
    // tiebreaker. A leading-wildcard LIKE search won't use these, but the
    // (org_id, deleted_at) prefix keeps the scanned set to one org's live rows.
    index("file_org_deleted_id_idx").on(t.orgId, t.deletedAt, t.id),
    index("file_org_deleted_category_id_idx").on(t.orgId, t.deletedAt, t.category, t.id),
    index("file_org_deleted_status_id_idx").on(t.orgId, t.deletedAt, t.status, t.id),
    index("file_org_deleted_name_id_idx").on(t.orgId, t.deletedAt, t.originalName, t.id),
    index("file_org_deleted_size_id_idx").on(t.orgId, t.deletedAt, t.sizeBytes, t.id),
    index("file_org_deleted_updated_id_idx").on(t.orgId, t.deletedAt, t.updatedAt, t.id),
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

// Per-card engagement counts for the public landing page + analytics (spec 0008).
// A daily rollup: one row per (file, day, metric), incremented with an UPSERT on
// each counted public hit, so growth is bounded and concurrent hits stay atomic.
// `org_id` scopes every read to one org and cascades on org delete; the file FK
// cascades so a hard-deleted card takes its counts with it, while unpublishing a
// card (which does not delete the row) keeps its history. Additive table only —
// no existing table is touched, so this migration cannot cascade-wipe (gotcha #9).
export const cardStatDaily = sqliteTable(
  "card_stat_daily",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    fileId: text("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    // Activity day as "YYYY-MM-DD" in UTC.
    date: text("date").notNull(),
    // "download" is the .vcf ("Add to contacts"); "pdf" is the .pdf save. Kept
    // apart so neither number quietly changes meaning.
    metric: text("metric", { enum: ["view", "scan", "download", "pdf"] }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    // One row per card/day/metric; the UPSERT conflict target.
    primaryKey({ columns: [t.fileId, t.date, t.metric] }),
    // Org-wide Dashboard rollups over a date range.
    index("card_stat_daily_org_date_idx").on(t.orgId, t.date),
    // Per-card reads within an org (Files page + card detail).
    index("card_stat_daily_org_file_idx").on(t.orgId, t.fileId),
    check(
      "card_stat_daily_metric_ck",
      sql`${t.metric} in ('view','scan','download','pdf')`,
    ),
  ],
);

// Site-wide app settings (spec 0009 follow-up). A single row (id = "app") holding
// global toggles. Kept out of the `organization` table on purpose: a rebuild of
// that parent table cascade-wipes children on D1 (gotcha #9), and these are
// site-level, not per-org. Additive table, so its migration is create-only.
export const appSettings = sqliteTable("app_settings", {
  id: text("id").primaryKey().default("app"),
  // When true, /c/* on the app host (www) requires a signed-in session (spec
  // 0009). Turn off to serve card pages publicly on www too. Counting stays
  // public-host-only regardless.
  requireAppHostCardLogin: integer("require_app_host_card_login", {
    mode: "boolean",
  })
    .notNull()
    .default(true),
  // DEPRECATED (spec 0012): the O365 sync toggle moved to org_settings (per-org).
  // This column is unused and kept only until app_settings is dropped in a later
  // migration; do not read or write it.
  o365SyncEnabled: integer("o365_sync_enabled", { mode: "boolean" })
    .notNull()
    .default(false),
  updatedAt: updatedAt(),
});

// Per-organization settings (spec 0012). One row per org, keyed by org_id.
// Additive table — a create-only migration; `organization` is never rebuilt
// (that cascade-wipes its children on D1, gotcha #9). A missing row is read as
// the defaults. Reached only through the org-db.ts wrapper (`orgDb().settings`),
// so a query cannot skip its org filter. Contrast `app_settings` above, which
// stays a single platform-level row for host-level policy that is checked before
// any card is resolved (`requireAppHostCardLogin`, spec 0012 decision).
export const orgSettings = sqliteTable("org_settings", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  // Office 365 CustomAttribute1 sync opt-in for THIS org's cards (spec 0010/0012).
  // Off by default; the sync also needs the org's OWN Entra credentials configured
  // (spec 0013, org_o365). Credentials gate (graphConfiguredForOrg), toggle switches.
  o365SyncEnabled: integer("o365_sync_enabled", { mode: "boolean" })
    .notNull()
    .default(false),
  updatedAt: updatedAt(),
});

// Per-organization Office 365 / Microsoft Graph credentials (spec 0013). Each org
// brings its OWN Entra app, so its cards sync into its OWN Microsoft tenant and no
// credential is ever global or shared. The client secret / certificate private key
// are stored ENCRYPTED (AES-GCM with the O365_CRED_KEK Worker secret — see
// secret-box.ts), never plaintext; tenant id, client id, and thumbprint are not
// secret. Additive create-only table (never rebuild `organization`, gotcha #9).
// Reached only through orgDb().graphCreds, so one org can't read another's.
export const orgO365 = sqliteTable("org_o365", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull(),
  clientId: text("client_id").notNull(),
  authMethod: text("auth_method", { enum: ["secret", "certificate"] }).notNull(),
  // AES-GCM ciphertext + iv of the client secret (null when auth_method is 'certificate').
  secretCt: text("secret_ct"),
  secretIv: text("secret_iv"),
  // AES-GCM ciphertext + iv of the PKCS8 private key (null when auth_method is 'secret').
  certKeyCt: text("cert_key_ct"),
  certKeyIv: text("cert_key_iv"),
  certThumbprint: text("cert_thumbprint"),
  lastVerifiedAt: integer("last_verified_at", { mode: "timestamp_ms" }),
  updatedAt: updatedAt(),
});

// An organization's verified email domains (spec 0014). Populated from the org's
// Microsoft 365 tenant (Graph GET /domains, verified only) when it configures
// O365, or added manually by the platform owner. Drives domain-based provisioning:
// an email whose domain matches maps to this org. One org per domain (unique);
// consumer domains (gmail.com, …) are rejected in code. Additive table.
export const orgDomains = sqliteTable(
  "org_domains",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(), // stored lowercased
    source: text("source", { enum: ["o365", "manual"] }).notNull(),
    verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("org_domains_domain_uq").on(t.domain),
    index("org_domains_org_idx").on(t.orgId),
  ],
);

// A platform-owner provisioning record (spec 0014): one email, one accept, N
// memberships. `assignments` is a JSON array of { orgId, role }. Parallel to the
// per-org `invitation` (org-admin) flow; its accept reuses the same account
// creation, then adds every assignment atomically. Additive table.
export const provision = sqliteTable(
  "provision",
  {
    id: id(),
    email: text("email").notNull(), // stored lowercased
    status: text("status", {
      enum: ["pending", "accepted", "cancelled"],
    }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    // JSON: [{ "orgId": "...", "role": "admin" | "member" }, ...]
    assignments: text("assignments").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [index("provision_email_status_idx").on(t.email, t.status)],
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

// Per-org SCIM bearer token (spec 0015). One config per org. Only the token's
// SHA-256 HASH is stored (never the token itself); a presented bearer is hashed
// and looked up here to resolve the org. Generated/rotated by the platform owner.
// Additive table.
export const scimToken = sqliteTable(
  "scim_token",
  {
    orgId: text("org_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: createdAt(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  },
  (t) => [uniqueIndex("scim_token_hash_uq").on(t.tokenHash)],
);

// Deferred email queue (spec 0015). A SCIM-created user's Exchange mailbox isn't
// ready instantly, so the "set your password" email is scheduled ~5 min out and
// sent by a cron flush once due. Additive table.
export const pendingEmail = sqliteTable(
  "pending_email",
  {
    id: id(),
    kind: text("kind").notNull(), // 'scim_set_password'
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    sendAfter: integer("send_after", { mode: "timestamp_ms" }).notNull(),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [index("pending_email_due_idx").on(t.sentAt, t.sendAfter)],
);
