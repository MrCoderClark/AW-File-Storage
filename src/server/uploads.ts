import {
  and,
  asc,
  desc,
  eq,
  gt,
  isNull,
  like,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { fileCategory } from "../lib/file-type";
import { buildLocationText } from "../lib/signature-brand";
import { buildDb } from "./db";
import * as schema from "./db/schema";
import { uuidv7 } from "./id";
import { orgDb } from "./org-db";
import {
  presignGet,
  presignPut,
  r2Copy,
  r2Delete,
  r2GetText,
  r2Head,
  r2Put,
  type R2Config,
} from "./r2";
import { deriveSlug, parseVcard, validateVcard } from "./vcard";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB (spec 0003 AC-4)
export const MAX_VCARD_BYTES = 262144; // 256 KB
const UPLOAD_LINK_TTL = 900; // 15 minutes (AC-1)

export interface UploadEnv {
  DB: D1Database;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_PRIVATE_BUCKET: string;
  R2_PUBLIC_BUCKET: string;
  PUBLIC_FILE_DOMAIN?: string;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * A globally-unique public slug (spec 0003 AC-8): start from the derived slug,
 * and on collision append a short random suffix, retrying a few times. The
 * public_slug column's global unique constraint is the ultimate arbiter.
 */
async function uniqueSlug(db: ReturnType<typeof buildDb>, base: string) {
  const b32 = "abcdefghijklmnopqrstuvwxyz234567";
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate =
      attempt === 0
        ? base
        : `${base}_${Array.from(crypto.getRandomValues(new Uint8Array(5)), (n) => b32[n % 32]).join("")}`;
    const existing = await db
      .select({ id: schema.files.id })
      .from(schema.files)
      .where(eq(schema.files.publicSlug, candidate))
      .limit(1);
    if (existing.length === 0) return candidate;
  }
  // Extremely unlikely; fall back to an id-based slug.
  return `${base}_${uuidv7().slice(0, 8)}`;
}

function r2Config(env: UploadEnv): R2Config {
  return {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  };
}

export class UploadError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function isVcard(name: string): boolean {
  return name.toLowerCase().endsWith(".vcf");
}

/**
 * Reserve an upload: check the cap and the org quota BEFORE issuing any signed
 * link (spec 0003 AC-4, 0002 AC-9), create the file + upload_session rows, and
 * return a presigned PUT scoped to one staging key in the private bucket.
 */
export async function requestUpload(
  env: UploadEnv,
  ctx: { orgId: string; userId: string },
  input: { name: string; size: number; contentType: string },
): Promise<{ fileId: string; uploadSessionId: string; url: string }> {
  const vcard = isVcard(input.name);
  const cap = vcard ? MAX_VCARD_BYTES : MAX_UPLOAD_BYTES;
  if (input.size <= 0 || input.size > cap) {
    throw new UploadError(413, `File exceeds the ${cap}-byte limit.`);
  }

  const db = buildDb(env.DB);
  const [org] = await db
    .select({
      used: schema.organization.storageUsedBytes,
      quota: schema.organization.storageQuotaBytes,
    })
    .from(schema.organization)
    .where(eq(schema.organization.id, ctx.orgId))
    .limit(1);
  if (!org) throw new UploadError(400, "No active organization.");
  const used = org.used ?? 0;
  const quota = org.quota ?? 0;
  if (used + input.size > quota) {
    throw new UploadError(
      409,
      `This upload would exceed your storage quota (using ${used} of ${quota} bytes).`,
    );
  }

  const uploadSessionId = uuidv7();
  const stagingKey = `incoming/${uploadSessionId}`;

  const scoped = orgDb(ctx.orgId, db);
  const file = await scoped.files.create({
    uploadedBy: ctx.userId,
    originalName: input.name,
    contentType: input.contentType,
    sizeBytes: input.size,
    // Unique placeholder until finalize computes the real digest (avoids the
    // (org_id, checksum) unique index colliding across pending uploads).
    checksumSha256: `pending:${uploadSessionId}`,
    storageKey: stagingKey,
    bucket: "private",
    visibility: "private",
    kind: vcard ? "vcard" : "other",
    status: "pending",
  });

  await scoped.uploads.create({
    id: uploadSessionId, // must match the id used in the staging key and returned
    userId: ctx.userId,
    fileId: file.id,
    stagingKey,
    declaredSizeBytes: input.size,
    declaredContentType: input.contentType,
    expiresAt: new Date(Date.now() + UPLOAD_LINK_TTL * 1000),
  });

  const url = await presignPut(
    r2Config(env),
    env.R2_PRIVATE_BUCKET,
    stagingKey,
    UPLOAD_LINK_TTL,
  );

  return { fileId: file.id, uploadSessionId, url };
}

export interface FinalizeResult {
  fileId: string;
  status: string;
  visibility: "private" | "public";
  publicUrl?: string;
}

/**
 * Finalize: read the staged object back over the S3 API (server-side truth, not
 * the browser's declaration), then either
 *   - validate + normalise + publish a vCard into the public bucket, or
 *   - move any other file to its permanent private key,
 * and add its real size to the org's usage. Idempotent on the upload session.
 */
export async function finalizeUpload(
  env: UploadEnv,
  ctx: { orgId: string },
  uploadSessionId: string,
): Promise<FinalizeResult> {
  const cfg = r2Config(env);
  const db = buildDb(env.DB);
  const scoped = orgDb(ctx.orgId, db);

  const session = await scoped.uploads.get(uploadSessionId);
  if (!session) throw new UploadError(404, "Upload session not found.");

  const file = await scoped.files.get(session.fileId);
  if (!file) throw new UploadError(404, "File not found.");
  if (session.completedAt) {
    // Idempotent: return the already-finalized result.
    return {
      fileId: file.id,
      status: file.status,
      visibility: file.visibility,
      publicUrl: publicUrlFor(env, file.publicSlug),
    };
  }

  const head = await r2Head(cfg, env.R2_PRIVATE_BUCKET, session.stagingKey);
  if (!head) {
    await scoped.files.update(session.fileId, {
      status: "failed",
      failureReason: "No uploaded bytes were found.",
    });
    throw new UploadError(422, "No uploaded bytes were found.");
  }
  const size = head.size;

  if (file.kind === "vcard") {
    return publishVcard(env, cfg, db, scoped, ctx.orgId, {
      id: session.id,
      fileId: file.id,
      stagingKey: session.stagingKey,
      originalName: file.originalName,
    });
  }

  // Any other file: move from staging to its permanent private key.
  const permKey = `files/${ctx.orgId}/${file.id}/${file.originalName}`;
  await r2Copy(cfg, env.R2_PRIVATE_BUCKET, permKey, env.R2_PRIVATE_BUCKET, session.stagingKey);
  await r2Delete(cfg, env.R2_PRIVATE_BUCKET, session.stagingKey);
  await scoped.files.update(file.id, {
    status: "ready",
    sizeBytes: size,
    storageKey: permKey,
    // Persist the coarse type so the Files list can filter on it in SQL.
    category: fileCategory(file.originalName, file.contentType, file.kind),
  });
  await addUsage(db, ctx.orgId, size);
  await scoped.uploads.markComplete(uploadSessionId);
  return { fileId: file.id, status: "ready", visibility: "private" };
}

export function publicUrlFor(env: UploadEnv, slug: string | null): string | undefined {
  if (!slug) return undefined;
  const domain = env.PUBLIC_FILE_DOMAIN ?? "contacts.americaworks.com";
  return `https://${domain}/c/${slug}.vcf`;
}

async function addUsage(
  db: ReturnType<typeof buildDb>,
  orgId: string,
  size: number,
): Promise<void> {
  await db
    .update(schema.organization)
    .set({
      storageUsedBytes: sql`${schema.organization.storageUsedBytes} + ${size}`,
    })
    .where(eq(schema.organization.id, orgId));
}

function publicKeyFor(slug: string): string {
  return `c/${slug}.vcf`;
}

const DOWNLOAD_LINK_TTL = 300; // 5 minutes (spec 0003 AC-12)

export interface ActorCtx {
  orgId: string;
  userId: string;
  canManageAny: boolean; // owner/admin may act on any file; members only their own
}

export interface FileListItem {
  id: string;
  name: string;
  kind: "vcard" | "other";
  status: string;
  visibility: "private" | "public";
  sizeBytes: number;
  contentType: string;
  publicUrl?: string;
  uploadedByName: string;
  // Denormalised contact fields (null for non-vCards) — shown as a subtitle and
  // searched server-side. The published .vcf remains the source of truth.
  contactName: string | null;
  contactOrg: string | null;
  createdAt: Date;
  updatedAt: Date;
  // Whether THIS caller may rename/unpublish/delete this file: owners/admins may
  // act on any file, members only on their own (spec 0004 invariant 1; the
  // server re-checks in each action). Lets the UI hide controls it must not offer.
  canManage: boolean;
}

/** How a Files-list page is sorted. "new" is the uuidv7 id (≈ upload time). */
export type FileSort = "new" | "name" | "size" | "modified";
export type SortDir = "asc" | "desc";
type FileStatus = "pending" | "uploading" | "validating" | "ready" | "failed";

export interface ListFilesOpts {
  q?: string;
  category?: string; // a FileCategory (lib/file-type.ts)
  kind?: "vcard" | "other";
  status?: FileStatus;
  sort?: FileSort;
  dir?: SortDir;
  cursor?: string | null;
  limit?: number;
}

export interface FilesPage {
  items: FileListItem[];
  nextCursor: string | null;
}

export const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

// The column set every list query selects — shared by the paged query so a row
// can be mapped to a FileListItem in one place.
const fileListColumns = {
  id: schema.files.id,
  name: schema.files.originalName,
  kind: schema.files.kind,
  status: schema.files.status,
  visibility: schema.files.visibility,
  sizeBytes: schema.files.sizeBytes,
  contentType: schema.files.contentType,
  publicSlug: schema.files.publicSlug,
  uploadedBy: schema.files.uploadedBy,
  uploaderName: schema.user.name,
  contactName: schema.files.contactName,
  contactOrg: schema.files.contactOrg,
  createdAt: schema.files.createdAt,
  updatedAt: schema.files.updatedAt,
} as const;

interface FileListRow {
  id: string;
  name: string;
  kind: "vcard" | "other";
  status: FileStatus;
  visibility: "private" | "public";
  sizeBytes: number;
  contentType: string;
  publicSlug: string | null;
  uploadedBy: string;
  uploaderName: string | null;
  contactName: string | null;
  contactOrg: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toListItem(
  env: UploadEnv,
  ctx: ActorCtx,
  f: FileListRow,
): FileListItem {
  return {
    id: f.id,
    name: f.name,
    kind: f.kind,
    status: f.status,
    visibility: f.visibility,
    sizeBytes: f.sizeBytes,
    contentType: f.contentType,
    publicUrl:
      f.visibility === "public" ? publicUrlFor(env, f.publicSlug) : undefined,
    uploadedByName: f.uploaderName ?? "Unknown",
    contactName: f.contactName,
    contactOrg: f.contactOrg,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    canManage: ctx.canManageAny || f.uploadedBy === ctx.userId,
  };
}

/** The `file` column a given sort orders by (the id is always the tiebreaker). */
function sortColumn(sort: FileSort) {
  switch (sort) {
    case "name":
      return schema.files.originalName;
    case "size":
      return schema.files.sizeBytes;
    case "modified":
      return schema.files.updatedAt;
    default:
      return schema.files.id;
  }
}

/** The sort value carried in the cursor for a row (id for "new"). */
function sortValueOf(sort: FileSort, row: FileListRow): string | number {
  switch (sort) {
    case "name":
      return row.name;
    case "size":
      return row.sizeBytes;
    case "modified":
      return row.updatedAt.getTime();
    default:
      return row.id;
  }
}

/** Opaque cursor: base64 of `[sortValue, id]` from the last row of a page. */
export function encodeCursor(sortValue: string | number, id: string): string {
  return Buffer.from(JSON.stringify([sortValue, id])).toString("base64url");
}

export function decodeCursor(
  cursor: string,
): { sortValue: string | number; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      (typeof parsed[0] === "string" || typeof parsed[0] === "number") &&
      typeof parsed[1] === "string"
    ) {
      return { sortValue: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through
  }
  return null;
}

// Escape LIKE wildcards in user input so a literal % or _ isn't a wildcard.
function likeContains(col: Parameters<typeof like>[0], term: string): SQL {
  const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`);
  return like(col, `%${escaped}%`);
}

/**
 * One keyset-paginated, filtered, sorted page of the org's live files (spec
 * 0003/0007). Ordering is `(sortColumn, id)` so the opaque cursor is stable
 * under concurrent inserts/deletes — no OFFSET. Search is a LIKE over the
 * filename, the denormalised contact fields, and the uploader's name.
 */
export async function listFilesPage(
  env: UploadEnv,
  ctx: ActorCtx,
  opts: ListFilesOpts = {},
): Promise<FilesPage> {
  const sort: FileSort = opts.sort ?? "new";
  const dir: SortDir = opts.dir ?? "desc";
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const db = buildDb(env.DB);

  const conds: (SQL | undefined)[] = [
    eq(schema.files.orgId, ctx.orgId),
    isNull(schema.files.deletedAt),
  ];

  const q = opts.q?.trim();
  if (q) {
    conds.push(
      or(
        likeContains(schema.files.originalName, q),
        likeContains(schema.files.contactName, q),
        likeContains(schema.files.contactOrg, q),
        likeContains(schema.files.contactTitle, q),
        likeContains(schema.files.contactEmail, q),
        likeContains(schema.files.contactLocation, q),
        likeContains(schema.user.name, q),
      ),
    );
  }
  if (opts.category) conds.push(eq(schema.files.category, opts.category));
  if (opts.kind) conds.push(eq(schema.files.kind, opts.kind));
  if (opts.status) conds.push(eq(schema.files.status, opts.status));

  // Keyset predicate: rows strictly after the cursor in the sort direction.
  const col = sortColumn(sort);
  if (opts.cursor) {
    const decoded = decodeCursor(opts.cursor);
    if (decoded) {
      const primary =
        sort === "modified"
          ? new Date(decoded.sortValue as number)
          : decoded.sortValue;
      const cmp = dir === "desc" ? lt : gt;
      conds.push(
        or(
          cmp(col, primary),
          and(eq(col, primary), cmp(schema.files.id, decoded.id)),
        ),
      );
    }
  }

  const dirFn = dir === "desc" ? desc : asc;
  const orderBy =
    sort === "new" ? [dirFn(schema.files.id)] : [dirFn(col), dirFn(schema.files.id)];

  const rows = await db
    .select(fileListColumns)
    .from(schema.files)
    .leftJoin(schema.user, eq(schema.user.id, schema.files.uploadedBy))
    .where(and(...conds))
    .orderBy(...orderBy)
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor(sortValueOf(sort, last), last.id) : null;

  return { items: page.map((f) => toListItem(env, ctx, f)), nextCursor };
}

/**
 * One-time, idempotent backfill of the denormalised search columns for existing
 * rows (spec 0007 follow-up): sets `category` for every live file, and reads
 * each ready vCard back from R2 to parse its contact fields. Safe to re-run —
 * it only touches rows still missing the values. Returns how many it updated.
 */
export async function backfillSearchFields(
  env: UploadEnv,
  ctx: ActorCtx,
): Promise<{ updated: number }> {
  const cfg = r2Config(env);
  const db = buildDb(env.DB);
  const scoped = orgDb(ctx.orgId, db);

  const rows = await db
    .select({
      id: schema.files.id,
      kind: schema.files.kind,
      status: schema.files.status,
      originalName: schema.files.originalName,
      contentType: schema.files.contentType,
      storageKey: schema.files.storageKey,
      category: schema.files.category,
      contactName: schema.files.contactName,
      contactLocation: schema.files.contactLocation,
    })
    .from(schema.files)
    .where(
      and(eq(schema.files.orgId, ctx.orgId), isNull(schema.files.deletedAt)),
    );

  let updated = 0;
  for (const f of rows) {
    const patch: Partial<typeof schema.files.$inferInsert> = {};
    if (f.category == null) {
      patch.category =
        f.kind === "vcard"
          ? "vcard"
          : fileCategory(f.originalName, f.contentType, f.kind);
    }
    // Re-read the card when any denormalised field is still missing — covers
    // rows backfilled before `contact_location` existed.
    if (
      f.kind === "vcard" &&
      f.status === "ready" &&
      (f.contactName == null || f.contactLocation == null)
    ) {
      const raw = await r2GetText(cfg, env.R2_PRIVATE_BUCKET, f.storageKey);
      if (raw) {
        const p = parseVcard(raw);
        patch.contactName = p.fullName || null;
        patch.contactOrg = p.organization || null;
        patch.contactTitle = p.title || null;
        patch.contactEmail = p.email || null;
        patch.contactLocation =
          buildLocationText(p.address.city, p.address.state) || null;
      }
    }
    if (Object.keys(patch).length > 0) {
      await scoped.files.update(f.id, patch);
      updated++;
    }
  }
  return { updated };
}

/** Rename a file's display name (spec 0007 AC-4). Org-scoped; canManage; audited. */
export async function renameFile(
  env: UploadEnv,
  ctx: ActorCtx,
  fileId: string,
  newName: string,
): Promise<void> {
  const name = newName.trim();
  if (!name) throw new UploadError(400, "A name is required.");
  const db = buildDb(env.DB);
  const scoped = orgDb(ctx.orgId, db);
  const file = await scoped.files.get(fileId);
  if (!file || file.deletedAt) throw new UploadError(404, "File not found.");
  assertCanManage(ctx, file);

  await scoped.files.update(fileId, { originalName: name });
  await scoped.audit.append({
    actorUserId: ctx.userId,
    action: "file.renamed",
    targetType: "file",
    targetId: fileId,
    metadataJson: JSON.stringify({ from: file.originalName, to: name }),
  });
}

/**
 * A short-lived signed URL to download a private file's bytes (spec 0003 AC-12).
 * Any member of the org may request one (all roles can see org files). The
 * private bucket has no public domain, so this is the only way to read it.
 */
export async function createPrivateLink(
  env: UploadEnv,
  ctx: ActorCtx,
  fileId: string,
): Promise<{ url: string; expiresAt: string }> {
  const db = buildDb(env.DB);
  const scoped = orgDb(ctx.orgId, db);
  const file = await scoped.files.get(fileId);
  if (!file || file.deletedAt) throw new UploadError(404, "File not found.");
  if (file.status !== "ready") {
    throw new UploadError(409, "This file is not ready to download.");
  }

  const url = await presignGet(
    r2Config(env),
    env.R2_PRIVATE_BUCKET,
    file.storageKey,
    DOWNLOAD_LINK_TTL,
  );
  await scoped.audit.append({
    actorUserId: ctx.userId,
    action: "file.link_created",
    targetType: "file",
    targetId: fileId,
  });
  return {
    url,
    expiresAt: new Date(Date.now() + DOWNLOAD_LINK_TTL * 1000).toISOString(),
  };
}

function assertCanManage(
  ctx: ActorCtx,
  file: { uploadedBy: string },
): void {
  if (!ctx.canManageAny && file.uploadedBy !== ctx.userId) {
    throw new UploadError(403, "You can only manage your own files.");
  }
}

/**
 * Edit a published vCard in place (spec 0006 follow-up): re-validate the rebuilt
 * card, overwrite both the durable private copy and the public object, and
 * refresh the denormalised search fields — all while KEEPING the existing
 * `public_slug`, so the card's public address (and any printed QR / shared link)
 * keeps resolving. Owner/admin, or the file's own uploader. Audited.
 */
export async function editVcard(
  env: UploadEnv,
  ctx: ActorCtx,
  fileId: string,
  vcardText: string,
  newName?: string,
): Promise<{ publicUrl?: string }> {
  const cfg = r2Config(env);
  const db = buildDb(env.DB);
  const scoped = orgDb(ctx.orgId, db);

  const file = await scoped.files.get(fileId);
  if (!file || file.deletedAt) throw new UploadError(404, "File not found.");
  assertCanManage(ctx, file);
  if (file.kind !== "vcard" || file.visibility !== "public" || !file.publicSlug) {
    throw new UploadError(409, "Only a published contact card can be edited.");
  }

  const result = validateVcard(vcardText);
  if (!result.ok) throw new UploadError(422, result.reason);

  const normalizedSize = new TextEncoder().encode(result.normalized).length;
  const checksum = await sha256Hex(result.normalized);

  // Reject an edit that would collide with a DIFFERENT live card in this org
  // (the (org_id, checksum) unique index). An unchanged card (same checksum on
  // this same row) is fine and simply rewrites the same bytes.
  const duplicate = await db
    .select({ id: schema.files.id })
    .from(schema.files)
    .where(
      and(
        eq(schema.files.orgId, ctx.orgId),
        eq(schema.files.checksumSha256, checksum),
        isNull(schema.files.deletedAt),
        ne(schema.files.id, fileId),
      ),
    )
    .limit(1);
  if (duplicate.length > 0) {
    throw new UploadError(409, "An identical contact card is already published.");
  }

  // Overwrite the durable private copy and the public publication at the SAME
  // slug (the URL never changes on an edit).
  await r2Put(cfg, env.R2_PRIVATE_BUCKET, file.storageKey, result.normalized);
  await r2Put(cfg, env.R2_PUBLIC_BUCKET, publicKeyFor(file.publicSlug), result.normalized, {
    "Content-Type": "text/vcard; charset=utf-8",
    "Content-Disposition": `attachment; filename="${file.publicSlug}.vcf"`,
    "Cache-Control": "public, max-age=300, s-maxage=300",
  });

  const parsed = parseVcard(result.normalized);
  await scoped.files.update(fileId, {
    sizeBytes: normalizedSize,
    checksumSha256: checksum,
    contactName: parsed.fullName || null,
    contactOrg: parsed.organization || null,
    contactTitle: parsed.title || null,
    contactEmail: parsed.email || null,
    contactLocation:
      buildLocationText(parsed.address.city, parsed.address.state) || null,
    ...(newName?.trim() ? { originalName: newName.trim() } : {}),
  });

  // Keep org usage correct by the size delta (can be negative).
  const delta = normalizedSize - file.sizeBytes;
  if (delta !== 0) {
    await db
      .update(schema.organization)
      .set({
        storageUsedBytes: sql`max(0, ${schema.organization.storageUsedBytes} + ${delta})`,
      })
      .where(eq(schema.organization.id, ctx.orgId));
  }

  await scoped.audit.append({
    actorUserId: ctx.userId,
    action: "vcard.edited",
    targetType: "file",
    targetId: fileId,
    metadataJson: JSON.stringify({ slug: file.publicSlug }),
  });

  return { publicUrl: publicUrlFor(env, file.publicSlug) };
}

/**
 * Unpublish a vCard (spec 0003 AC-11): remove the public object so the address
 * returns 404, keep the durable private copy, and retire (not recycle) the slug.
 */
export async function unpublishVcard(
  env: UploadEnv,
  ctx: ActorCtx,
  fileId: string,
): Promise<void> {
  const cfg = r2Config(env);
  const db = buildDb(env.DB);
  const scoped = orgDb(ctx.orgId, db);

  const file = await scoped.files.get(fileId);
  if (!file || file.deletedAt) throw new UploadError(404, "File not found.");
  assertCanManage(ctx, file);
  if (file.visibility !== "public" || !file.publicSlug) {
    return; // already not public — idempotent
  }

  await r2Delete(cfg, env.R2_PUBLIC_BUCKET, publicKeyFor(file.publicSlug));
  await scoped.files.update(fileId, {
    visibility: "private",
    publishedAt: null,
    // public_slug is intentionally kept so it is retired, not recycled.
  });
  await scoped.audit.append({
    actorUserId: ctx.userId,
    action: "vcard.unpublished",
    targetType: "file",
    targetId: fileId,
    metadataJson: JSON.stringify({ slug: file.publicSlug }),
  });
}

/**
 * Soft-delete a file (spec 0002 AC-7). If it was published, the public object is
 * removed immediately so the address stops resolving; the private object is
 * reclaimed by the scheduled sweep. Usage is decremented.
 */
export async function deleteFile(
  env: UploadEnv,
  ctx: ActorCtx,
  fileId: string,
): Promise<void> {
  const cfg = r2Config(env);
  const db = buildDb(env.DB);
  const scoped = orgDb(ctx.orgId, db);

  const file = await scoped.files.get(fileId);
  if (!file || file.deletedAt) throw new UploadError(404, "File not found.");
  assertCanManage(ctx, file);

  if (file.visibility === "public" && file.publicSlug) {
    await r2Delete(cfg, env.R2_PUBLIC_BUCKET, publicKeyFor(file.publicSlug));
  }
  await scoped.files.softDelete(fileId, ctx.userId);
  if (file.sizeBytes > 0) {
    await db
      .update(schema.organization)
      .set({
        storageUsedBytes: sql`max(0, ${schema.organization.storageUsedBytes} - ${file.sizeBytes})`,
      })
      .where(eq(schema.organization.id, ctx.orgId));
  }
  await scoped.audit.append({
    actorUserId: ctx.userId,
    action: "file.deleted",
    targetType: "file",
    targetId: fileId,
    metadataJson: JSON.stringify({ name: file.originalName }),
  });
}

async function publishVcard(
  env: UploadEnv,
  cfg: R2Config,
  db: ReturnType<typeof buildDb>,
  scoped: ReturnType<typeof orgDb>,
  orgId: string,
  session: { id: string; fileId: string; stagingKey: string; originalName: string },
): Promise<FinalizeResult> {
  const raw = await r2GetText(cfg, env.R2_PRIVATE_BUCKET, session.stagingKey);
  const result = raw ? validateVcard(raw) : ({ ok: false, reason: "No bytes." } as const);
  if (!result.ok) {
    await scoped.files.update(session.fileId, {
      status: "failed",
      failureReason: result.reason,
    });
    await r2Delete(cfg, env.R2_PRIVATE_BUCKET, session.stagingKey);
    throw new UploadError(422, result.reason);
  }

  const normalizedSize = new TextEncoder().encode(result.normalized).length;
  const checksum = await sha256Hex(result.normalized);

  // Dedup: an identical card already live in this org would violate the
  // (org_id, checksum) unique index. Fail gracefully instead of crashing.
  const duplicate = await db
    .select({ id: schema.files.id })
    .from(schema.files)
    .where(
      and(
        eq(schema.files.orgId, orgId),
        eq(schema.files.checksumSha256, checksum),
        isNull(schema.files.deletedAt),
        ne(schema.files.id, session.fileId),
      ),
    )
    .limit(1);
  if (duplicate.length > 0) {
    await scoped.files.update(session.fileId, {
      status: "failed",
      failureReason: "An identical contact card is already published.",
    });
    await r2Delete(cfg, env.R2_PRIVATE_BUCKET, session.stagingKey);
    throw new UploadError(
      409,
      "An identical contact card is already published.",
    );
  }

  const slug = await uniqueSlug(db, deriveSlug(result.formattedName));

  // Durable private copy (kept so a card can be unpublished without losing it),
  // plus the public publication served at c/<slug>.vcf.
  const privateKey = `files/${orgId}/${session.fileId}/${session.originalName}`;
  await r2Put(cfg, env.R2_PRIVATE_BUCKET, privateKey, result.normalized);
  await r2Put(cfg, env.R2_PUBLIC_BUCKET, publicKeyFor(slug), result.normalized, {
    "Content-Type": "text/vcard; charset=utf-8",
    "Content-Disposition": `attachment; filename="${slug}.vcf"`,
    "Cache-Control": "public, max-age=300, s-maxage=300",
  });
  await r2Delete(cfg, env.R2_PRIVATE_BUCKET, session.stagingKey);

  // Denormalise the contact fields so the Files list can search them in SQL
  // (the published .vcf stays the source of truth).
  const parsed = parseVcard(result.normalized);
  await scoped.files.update(session.fileId, {
    status: "ready",
    visibility: "public",
    bucket: "private", // storage_key points at the durable private copy
    publicSlug: slug,
    publishedAt: new Date(),
    storageKey: privateKey,
    sizeBytes: normalizedSize,
    checksumSha256: checksum,
    contactName: parsed.fullName || null,
    contactOrg: parsed.organization || null,
    contactTitle: parsed.title || null,
    contactEmail: parsed.email || null,
    contactLocation:
      buildLocationText(parsed.address.city, parsed.address.state) || null,
    category: "vcard",
  });
  await addUsage(db, orgId, normalizedSize);
  await scoped.audit.append({
    actorUserId: null,
    action: "vcard.published",
    targetType: "file",
    targetId: session.fileId,
    metadataJson: JSON.stringify({ slug, url: publicUrlFor(env, slug) }),
  });
  await scoped.uploads.markComplete(session.id);

  return {
    fileId: session.fileId,
    status: "ready",
    visibility: "public",
    publicUrl: publicUrlFor(env, slug),
  };
}
