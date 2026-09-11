import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
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
    // The UNSUFFIXED slug derived from the contact name (spec 0028 AC-7). `public_slug`
    // is globally unique and gets a random suffix on a cross-org collision; `slug_base`
    // keeps the bare `First_Last` so a bulk import can enforce ONE card per person per
    // org through the partial unique index below, rather than a racy read-then-write.
    // Only set by the bulk-import publish path for now; null on cards from every other
    // path (so their behaviour is unchanged).
    slugBase: text("slug_base"),
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
    // Provenance (spec 0016): 'manual' for every human-created/uploaded file (the
    // default, and what all existing rows are); 'o365_auto' marks a card that was
    // auto-provisioned from the Office 365 directory, so offboarding and the
    // non-clobber rule can tell auto cards from human-authored ones.
    source: text("source").notNull().default("manual"),
    // When the card was retracted because its O365 user was offboarded (spec 0017).
    // Set on retract, cleared on re-publish; a nightly purge hard-deletes cards whose
    // offboarded_at is older than the 30-day grace window. Null for normal cards.
    offboardedAt: integer("offboarded_at", { mode: "timestamp_ms" }),
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
    // One live card per (org, derived name slug) for the bulk-import path (spec 0028
    // AC-7): two import rows in one sheet — or across concurrent drains — that derive
    // the same slug cannot both publish. Partial, so it only constrains rows that set
    // slug_base (import cards) and ignores soft-deleted ones.
    uniqueIndex("file_org_slug_base_uq")
      .on(t.orgId, t.slugBase)
      .where(sql`${t.slugBase} is not null and ${t.deletedAt} is null`),
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

// Per-visitor engagement events for cards (spec 0030). An append-only detail
// layer BESIDE the daily rollup above: one row per counted public hit, capturing
// who engaged (external IP + Cloudflare geo/network), on what device (raw
// User-Agent; device/OS/browser are DERIVED at read time, never stored, so an
// improved parser applies to old rows), from where (referrer), and how (metric +
// src). Written best-effort on the same `waitUntil` as the rollup, only for a
// countable User-Agent on the public host, so events and counts stay in lockstep.
//
// `org_id` scopes every read and cascades on org delete; the `file` FK cascades so
// a hard-deleted card takes its visit rows with it. Raw rows are personal data,
// so they are owner/admin-only to read and are purged after 12 months by the
// nightly cron (the rollup above is never purged). There is NO composite key —
// every hit is a distinct event (contrast the rollup's UPSERT). Additive table
// only; no existing table is touched, so this migration cannot cascade-wipe
// (gotcha #9).
export const cardVisitEvent = sqliteTable(
  "card_visit_event",
  {
    // uuidv7: time-sortable, so it doubles as the keyset tiebreaker with created_at.
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    fileId: text("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    // Mirrors card_stat_daily.metric so the event log and the aggregate agree.
    metric: text("metric", { enum: ["view", "scan", "download", "pdf"] }).notNull(),
    createdAt: createdAt(),
    // Full external IP (CF-Connecting-IP). A private/NAT IP is never available.
    ip: text("ip"),
    // Salted hash of ip + user-agent + UTC day (server secret IP_HASH_SALT): a
    // grouping key for the approximate unique-visitor count, not a confidentiality
    // measure (an admin sees the raw ip on the same row). The salt keeps it from
    // being rehashable against guessed IPs if `ip` is ever redacted later.
    visitorHash: text("visitor_hash"),
    // Cloudflare geo/network (cf.* under OpenNext), with the CF-IPCountry header as
    // the country fallback. Null when the field is unavailable.
    country: text("country"),
    region: text("region"),
    city: text("city"),
    postal: text("postal"),
    latitude: real("latitude"),
    longitude: real("longitude"),
    timezone: text("timezone"),
    asn: integer("asn"),
    asOrg: text("as_org"),
    // Raw User-Agent; device/OS/browser are derived from this at read time.
    userAgent: text("user_agent"),
    referrer: text("referrer"),
    // Landing source, e.g. "qr" for a QR scan.
    src: text("src"),
  },
  (t) => [
    // Every index leads with org_id (platform rule). Newest-first org feed:
    index("card_visit_event_org_created_idx").on(t.orgId, t.createdAt),
    // Per-card filter:
    index("card_visit_event_org_file_created_idx").on(
      t.orgId,
      t.fileId,
      t.createdAt,
    ),
    // Metric-only filter:
    index("card_visit_event_org_metric_created_idx").on(
      t.orgId,
      t.metric,
      t.createdAt,
    ),
    // Unique-visitor tallies (COUNT DISTINCT visitor_hash):
    index("card_visit_event_org_visitor_idx").on(t.orgId, t.visitorHash),
    check(
      "card_visit_event_metric_ck",
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
  // Auto-create + publish a contact card from each licensed O365 user's directory
  // details, and keep it in sync (spec 0016). Off by default; also needs
  // o365SyncEnabled on + the org's own credentials. Opt-in because it publishes staff
  // PII to public URLs.
  o365AutoCardEnabled: integer("o365_auto_card_enabled", { mode: "boolean" })
    .notNull()
    .default(false),
  // The cutoff for auto-provisioning (spec 0016): only O365 users CREATED at/after
  // this instant get a card, so enabling the feature never backfills existing staff.
  // Set to "now" each time the toggle is turned on.
  o365AutoCardSince: integer("o365_auto_card_since", { mode: "timestamp_ms" }),
  // Retract + (after 30 days) delete a card when its O365 user is offboarded —
  // disabled AND unlicensed (spec 0017). Off by default; independent of auto-create.
  // Covers manual cards too, but only on the org's own verified O365 domains.
  o365RemoveOnOffboardEnabled: integer("o365_remove_on_offboard_enabled", {
    mode: "boolean",
  })
    .notNull()
    .default(false),
  // Per-org override for the bulk-import rate limit (spec 0029). Null means "no
  // override": the submit path falls back to the IMPORT_RATE_PER_HOUR env default.
  // When set, it is constrained to 1..100 in application code (never at the column,
  // so an out-of-range value is a 400, not a DB error). Additive ADD COLUMN on this
  // leaf table — org_settings is never rebuilt (gotcha #9).
  importRatePerHour: integer("import_rate_per_hour"),
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

// In-app help & documentation CMS (spec 0024). Per-org articles authored by an org's
// owner/admin; the platform owner additionally authors global content in their OWN org and
// flags it `shared` so it shows in every org. Readers see own-org published PLUS shared
// published (the one cross-org read, in orgDb().help.listForReader). `body_html` is
// sanitized before store. Reader routes by `id`, so `slug` is cosmetic and needs no
// cross-org uniqueness. Additive leaf tables — a create-only migration, no parent rebuild
// (gotcha #9).
export const helpArticles = sqliteTable(
  "help_article",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    slug: text("slug").notNull(), // cosmetic label; the reader routes by id
    category: text("category").notNull().default("General"),
    bodyHtml: text("body_html").notNull().default(""), // sanitized on save (help-sanitize.ts)
    excerpt: text("excerpt"),
    // Contextual help: matches a stable per-route key so the drawer can show
    // "for this page" articles. Null = not tied to a page.
    pageKey: text("page_key"),
    status: text("status", { enum: ["draft", "published"] })
      .notNull()
      .default("draft"),
    // Platform-owner-only flag (set from their own org): makes the article visible to every
    // org's readers. Never a cross-org write; only a cross-org read (listForReader).
    shared: integer("shared", { mode: "boolean" }).notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    // Knowledge base fields (spec 0025). `category_id`/`featured_image_id` are LOGICAL
    // references (not DB foreign keys) so these stay pure additive ADD COLUMNs with no
    // help_article rebuild on D1 (gotcha #9); the relationships are enforced in orgDb().help.
    categoryId: text("category_id"), // -> help_category.id (same org), or null
    tags: text("tags").notNull().default("[]"), // JSON string array
    featuredImageId: text("featured_image_id"), // -> help_image.id, or null
    relatedIds: text("related_ids").notNull().default("[]"), // JSON array of same-org article ids
    // Who may read a published article: 'all' signed-in staff, or 'admins' only (spec 0025).
    // Enforced in the reader queries by the caller's role. Independent of `shared` (cross-org).
    audience: text("audience", { enum: ["all", "admins"] }).notNull().default("all"),
    // Reader engagement counters (spec 0026 polish), own-org only. Additive, default 0.
    viewCount: integer("view_count").notNull().default(0),
    helpfulCount: integer("helpful_count").notNull().default(0),
    unhelpfulCount: integer("unhelpful_count").notNull().default(0),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    updatedBy: text("updated_by").references(() => user.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("help_article_org_status_cat_idx").on(
      t.orgId,
      t.status,
      t.category,
      t.sortOrder,
    ),
    index("help_article_org_pagekey_idx").on(t.orgId, t.pageKey),
    // Serves the cross-org shared read (spec 0024). Intentionally does NOT lead with org_id
    // (the one documented exception to the org_id-leading index rule).
    index("help_article_shared_status_idx").on(t.shared, t.status),
    check("help_article_status_ck", sql`${t.status} in ('draft','published')`),
  ],
);

// Images embedded in help articles (spec 0024). Stored in the PRIVATE R2 bucket and served
// through an authorized route (own-org, or referenced by a published+shared article), never
// publicly enumerable. `article_id` is nullable until the article is first saved, then set
// so the serve route can authorize and orphans can be swept.
export const helpImages = sqliteTable(
  "help_image",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    articleId: text("article_id").references(() => helpArticles.id, {
      onDelete: "cascade",
    }),
    r2Key: text("r2_key").notNull(),
    contentType: text("content_type").notNull(),
    uploadedBy: text("uploaded_by").references(() => user.id),
    // Media library fields (spec 0026), all additive + nullable (no rebuild — gotcha #9).
    // New uploads are library-owned (article_id null) and reused by reference scan.
    filename: text("filename"), // editable display name; original file name on upload
    title: text("title"), // optional human title (media library details, spec 0026)
    caption: text("caption"), // optional caption (media library details, spec 0026)
    altText: text("alt_text"), // applied to the img alt on insert + featured image
    width: integer("width"), // intrinsic pixels after client downscale
    height: integer("height"),
    sizeBytes: integer("size_bytes"), // final stored byte size, for the library display
    createdAt: createdAt(),
  },
  (t) => [index("help_image_org_article_idx").on(t.orgId, t.articleId)],
);

// Help knowledge-base categories (spec 0025). A per-org, nestable list: articles belong to a
// category, and the CMS + reader group by it. `parent_id` is a LOGICAL self-reference (not a DB
// foreign key) so category management is simple and the migration stays a plain CREATE TABLE;
// orgDb().help enforces that a parent and an article's category live in the same org, and
// re-parents children to null on delete. Additive leaf table (no parent rebuild, gotcha #9).
export const helpCategories = sqliteTable(
  "help_category",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    parentId: text("parent_id"), // -> help_category.id (same org), or null for a top-level category
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("help_category_org_parent_idx").on(t.orgId, t.parentId, t.sortOrder)],
);

// Bulk contact-card import (spec 0028). Two additive leaf tables track an import run
// and its per-row outcomes; the published cards themselves are ordinary `file` rows
// made by the existing publish pipeline (publishVcardFromBytes). Reached only through
// orgDb().cardImports, so a query cannot skip its org filter. Create-only migration —
// `organization`/`file` are never rebuilt (gotcha #9).
//
// `card_import.id` is the CLIENT-generated import id (a uuid the browser mints), so a
// repeat submit collides on the primary key and is treated as the same import (AC-11):
// it is NOT the server-default id().
export const cardImports = sqliteTable(
  "card_import",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => user.id),
    status: text("status", {
      enum: [
        "pending",
        "processing",
        "completed",
        "completed_with_errors",
        "failed",
      ],
    })
      .notNull()
      .default("pending"),
    totalRows: integer("total_rows").notNull().default(0),
    publishedCount: integer("published_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Listing an org's imports, newest first.
    index("card_import_org_created_idx").on(t.orgId, t.createdAt),
    // The per-user hourly submission rate limit counts an org's imports by actor+time (AC-9).
    index("card_import_org_actor_created_idx").on(
      t.orgId,
      t.actorUserId,
      t.createdAt,
    ),
    check(
      "card_import_status_ck",
      sql`${t.status} in ('pending','processing','completed','completed_with_errors','failed')`,
    ),
  ],
);

// One row per source spreadsheet row. Stores the server-validated MAPPED field set
// (payload_json) so publishing happens in the background drain, not in the submit
// request (spec 0028 AC-6). `(import_id, row_number)` is unique — the idempotency key
// for a resumed drain so a row is never published twice (AC-13).
export const cardImportRows = sqliteTable(
  "card_import_row",
  {
    id: id(),
    importId: text("import_id")
      .notNull()
      .references(() => cardImports.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // The source spreadsheet row number, shown in the report.
    rowNumber: integer("row_number").notNull(),
    // The derived full name shown in the report (null when the row has no usable name).
    contactName: text("contact_name"),
    // The mapped CardFields for this contact as JSON (not raw spreadsheet cells). The
    // drain rebuilds the vCard from this and publishes it. Server-validated before store.
    payloadJson: text("payload_json").notNull(),
    outcome: text("outcome", {
      enum: ["pending", "processing", "published", "skipped", "failed"],
    })
      .notNull()
      .default("pending"),
    // Why the row was skipped or failed (null otherwise).
    reason: text("reason"),
    // Drain attempt count for bounded retry (AC-13): a row that keeps failing is marked
    // `failed` once attempts reach CARD_IMPORT_MAX_ATTEMPTS rather than retried forever.
    attempts: integer("attempts").notNull().default(0),
    // When a drain last claimed the row (pending -> processing). A `processing` row older
    // than a reclaim threshold is returned to `pending` for the next drain (AC-13).
    claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
    // The published card when outcome = published; null when pending/skipped/failed.
    fileId: text("file_id").references(() => files.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The idempotency key for a resumed drain (AC-11 storage half / AC-13).
    uniqueIndex("card_import_row_import_rownum_uq").on(t.importId, t.rowNumber),
    // Find `pending` (and stale `processing`) rows to drain, across orgs.
    index("card_import_row_outcome_claimed_idx").on(t.outcome, t.claimedAt),
    // Read one import's rows (org-scoped) for the results view.
    index("card_import_row_org_import_idx").on(t.orgId, t.importId),
    check(
      "card_import_row_outcome_ck",
      sql`${t.outcome} in ('pending','processing','published','skipped','failed')`,
    ),
  ],
);
