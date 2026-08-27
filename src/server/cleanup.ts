import { and, inArray, isNull, lt } from "drizzle-orm";
import { buildDb } from "./db";
import * as schema from "./db/schema";
import { r2Delete } from "./r2";

/**
 * Scheduled cleanup (spec 0003 AC-14): abandoned uploads leave nothing
 * permanent. An upload_session past its expiry with no completion means the
 * browser never finalized — delete its staging object from R2 and its pending
 * file row (which cascades the session away). Idempotent and safe: only files
 * that never reached `ready` are removed.
 */
export interface CleanupEnv {
  DB: D1Database;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_PRIVATE_BUCKET: string;
}

export async function runCleanup(
  env: CleanupEnv,
): Promise<{ sweptSessions: number }> {
  const db = buildDb(env.DB);
  const cfg = {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  };

  const expired = await db
    .select()
    .from(schema.uploadSessions)
    .where(
      and(
        isNull(schema.uploadSessions.completedAt),
        lt(schema.uploadSessions.expiresAt, new Date()),
      ),
    );

  for (const session of expired) {
    // Remove the orphaned staging object (already gone -> no-op).
    await r2Delete(cfg, env.R2_PRIVATE_BUCKET, session.stagingKey).catch(() => {});
    // Delete the never-finalized file (guarded to non-ready), cascading the
    // upload_session row via its FK.
    await db
      .delete(schema.files)
      .where(
        and(
          inArray(schema.files.id, [session.fileId]),
          inArray(schema.files.status, [
            "pending",
            "uploading",
            "validating",
            "failed",
          ]),
        ),
      );
  }

  return { sweptSessions: expired.length };
}
