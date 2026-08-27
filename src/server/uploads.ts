import { eq, sql } from "drizzle-orm";
import { buildDb } from "./db";
import * as schema from "./db/schema";
import { uuidv7 } from "./id";
import { orgDb } from "./org-db";
import { presignPut, r2Head, type R2Config } from "./r2";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB (spec 0003 AC-4)
export const MAX_VCARD_BYTES = 262144; // 256 KB
const UPLOAD_LINK_TTL = 900; // 15 minutes (AC-1)

export interface UploadEnv {
  DB: D1Database;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_PRIVATE_BUCKET: string;
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

/**
 * Finalize: read the staged object back through the binding (server-side truth,
 * not the browser's declaration), confirm it arrived, mark the file ready, and
 * add its real size to the org's usage.
 *
 * NOTE (Phase 3a tracer): this leaves the object at its staging key and marks
 * the file ready. vCard validation, the move to the permanent key, the queue,
 * and publishing to the public bucket come in 3b.
 */
export async function finalizeUpload(
  env: UploadEnv,
  ctx: { orgId: string },
  uploadSessionId: string,
): Promise<{ fileId: string; status: string; size: number }> {
  const db = buildDb(env.DB);
  const scoped = orgDb(ctx.orgId, db);

  const session = await scoped.uploads.get(uploadSessionId);
  if (!session) throw new UploadError(404, "Upload session not found.");
  if (session.completedAt) {
    const existing = await scoped.files.get(session.fileId);
    return {
      fileId: session.fileId,
      status: existing?.status ?? "ready",
      size: existing?.sizeBytes ?? 0,
    };
  }

  const head = await r2Head(
    r2Config(env),
    env.R2_PRIVATE_BUCKET,
    session.stagingKey,
  );
  if (!head) {
    await scoped.files.update(session.fileId, {
      status: "failed",
      failureReason: "No uploaded bytes were found.",
    });
    throw new UploadError(422, "No uploaded bytes were found.");
  }

  const size = head.size;
  await scoped.files.update(session.fileId, { status: "ready", sizeBytes: size });
  await db
    .update(schema.organization)
    .set({ storageUsedBytes: sql`${schema.organization.storageUsedBytes} + ${size}` })
    .where(eq(schema.organization.id, ctx.orgId));
  await scoped.uploads.markComplete(uploadSessionId);

  return { fileId: session.fileId, status: "ready", size };
}
