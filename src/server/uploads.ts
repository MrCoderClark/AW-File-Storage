import { eq, sql } from "drizzle-orm";
import { buildDb } from "./db";
import * as schema from "./db/schema";
import { uuidv7 } from "./id";
import { orgDb } from "./org-db";
import {
  presignPut,
  r2Copy,
  r2Delete,
  r2GetText,
  r2Head,
  r2Put,
  type R2Config,
} from "./r2";
import { deriveSlug, validateVcard } from "./vcard";

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
        : `${base}-${Array.from(crypto.getRandomValues(new Uint8Array(5)), (n) => b32[n % 32]).join("")}`;
    const existing = await db
      .select({ id: schema.files.id })
      .from(schema.files)
      .where(eq(schema.files.publicSlug, candidate))
      .limit(1);
    if (existing.length === 0) return candidate;
  }
  // Extremely unlikely; fall back to an id-based slug.
  return `${base}-${uuidv7().slice(0, 8)}`;
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
    return publishVcard(env, cfg, db, scoped, ctx.orgId, session, size);
  }

  // Any other file: move from staging to its permanent private key.
  const permKey = `files/${ctx.orgId}/${file.id}/${file.originalName}`;
  await r2Copy(cfg, env.R2_PRIVATE_BUCKET, permKey, env.R2_PRIVATE_BUCKET, session.stagingKey);
  await r2Delete(cfg, env.R2_PRIVATE_BUCKET, session.stagingKey);
  await scoped.files.update(file.id, {
    status: "ready",
    sizeBytes: size,
    storageKey: permKey,
  });
  await addUsage(db, ctx.orgId, size);
  await scoped.uploads.markComplete(uploadSessionId);
  return { fileId: file.id, status: "ready", visibility: "private" };
}

function publicUrlFor(env: UploadEnv, slug: string | null): string | undefined {
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

async function publishVcard(
  env: UploadEnv,
  cfg: R2Config,
  db: ReturnType<typeof buildDb>,
  scoped: ReturnType<typeof orgDb>,
  orgId: string,
  session: { id: string; fileId: string; stagingKey: string },
  size: number,
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

  const slug = await uniqueSlug(db, deriveSlug(result.formattedName));
  const publicKey = `c/${slug}.vcf`;
  await r2Put(cfg, env.R2_PUBLIC_BUCKET, publicKey, result.normalized, {
    "Content-Type": "text/vcard; charset=utf-8",
    "Content-Disposition": `attachment; filename="${slug}.vcf"`,
    "Cache-Control": "public, max-age=300, s-maxage=300",
  });
  await r2Delete(cfg, env.R2_PRIVATE_BUCKET, session.stagingKey);

  await scoped.files.update(session.fileId, {
    status: "ready",
    visibility: "public",
    bucket: "public",
    publicSlug: slug,
    publishedAt: new Date(),
    storageKey: publicKey,
    sizeBytes: new TextEncoder().encode(result.normalized).length,
    checksumSha256: await sha256Hex(result.normalized),
  });
  await addUsage(db, orgId, size);
  await scoped.uploads.markComplete(session.id);

  return {
    fileId: session.fileId,
    status: "ready",
    visibility: "public",
    publicUrl: publicUrlFor(env, slug),
  };
}
