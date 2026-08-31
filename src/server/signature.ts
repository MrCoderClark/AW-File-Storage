import { and, eq, isNull } from "drizzle-orm";
import { buildDb } from "./db";
import * as schema from "./db/schema";
import { orgDb } from "./org-db";
import { r2GetText, type R2Config } from "./r2";
import { publicUrlFor, type UploadEnv } from "./uploads";
import { type ParsedVcard, parseVcard } from "./vcard";

/**
 * Printable-signature resolution (spec 0009). The stored `.vcf` is the single
 * source of truth — we parse it on demand rather than persisting any signature
 * fields. Two entry points:
 *   - getCardForSignature: authenticated + org-scoped, reads the durable private
 *     copy and returns parsed fields (drives the signature page).
 *   - resolvePublishedCardUrl: public + unauthenticated, needs only the slug
 *     (drives the QR image endpoint, which email recipients fetch with no cookie).
 */

function r2Config(env: UploadEnv): R2Config {
  return {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  };
}

export interface SignatureCard {
  id: string;
  /** The file's display name. */
  name: string;
  /** Public vCard address served from the R2 public bucket. */
  publicUrl: string;
  card: ParsedVcard;
}

/**
 * Parsed fields for a published vCard the caller may see, or null when the file
 * isn't a published card in the caller's org. Org-scoped through `orgDb`, so a
 * card in another organization is indistinguishable from one that doesn't exist.
 */
export async function getCardForSignature(
  env: UploadEnv,
  ctx: { orgId: string },
  fileId: string,
): Promise<SignatureCard | null> {
  const db = buildDb(env.DB);
  const scoped = orgDb(ctx.orgId, db);
  const file = await scoped.files.get(fileId);
  if (!file || file.deletedAt) return null;
  if (file.kind !== "vcard" || file.visibility !== "public" || !file.publicSlug) {
    return null;
  }

  const raw = await r2GetText(
    r2Config(env),
    env.R2_PRIVATE_BUCKET,
    file.storageKey,
  );
  if (!raw) return null;

  return {
    id: file.id,
    name: file.originalName,
    publicUrl: publicUrlFor(env, file.publicSlug) ?? "",
    card: parseVcard(raw),
  };
}

/**
 * The public URL for a published card by id, with NO org scope — a published
 * card is already world-readable, so its QR (which only encodes that URL) can be
 * served to an unauthenticated email client. Null if the id isn't a live,
 * published card.
 */
export async function resolvePublishedCardUrl(
  env: UploadEnv,
  fileId: string,
): Promise<string | null> {
  const db = buildDb(env.DB);
  const [row] = await db
    .select({ slug: schema.files.publicSlug })
    .from(schema.files)
    .where(
      and(
        eq(schema.files.id, fileId),
        eq(schema.files.visibility, "public"),
        isNull(schema.files.deletedAt),
      ),
    )
    .limit(1);
  if (!row?.slug) return null;
  return publicUrlFor(env, row.slug) ?? null;
}
