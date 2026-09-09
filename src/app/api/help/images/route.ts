import { getCloudflareContext } from "@opennextjs/cloudflare";
import { uuidv7 } from "@/server/id";
import { orgDbFor } from "@/server/org-db";
import { presignPut } from "@/server/r2";
import { requireApiRole } from "@/server/session";

// Help image uploads + media library (spec 0024 AC-7, spec 0026). Owner/admin, org-scoped.
// POST reserves a presigned PUT to the PRIVATE bucket (bytes go straight to R2) and creates the
// help_image row, now recording the media-library metadata (filename, dimensions, size). New
// uploads are library-owned (article_id null) and reused by reference. GET lists the library.
export const dynamic = "force-dynamic";

interface Env {
  DB: D1Database;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_PRIVATE_BUCKET: string;
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
const UPLOAD_TTL = 300; // 5 minutes

// The media library for the caller's org: id, name, type, size, dimensions, and whether any
// article uses it (spec 0026 AC-1).
export async function GET() {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { env } = getCloudflareContext();
  const e = env as unknown as Env;
  const scoped = orgDbFor(auth.actor.orgId, e.DB);
  const images = await scoped.help.listImages();
  return Response.json({
    ok: true,
    images: images.map((img) => ({ ...img, url: `/api/help/images/${img.id}` })),
  });
}

export async function POST(req: Request) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => ({}))) as {
    contentType?: string;
    articleId?: string;
    filename?: string;
    width?: number;
    height?: number;
    size?: number;
    alt?: string;
  };
  const ext = body.contentType ? EXT[body.contentType] : undefined;
  if (!ext) {
    return Response.json(
      { ok: false, error: "Only PNG, JPEG, GIF, or WebP images are allowed." },
      { status: 400 },
    );
  }

  const { env } = getCloudflareContext();
  const e = env as unknown as Env;
  const imageId = uuidv7();
  const key = `help/${auth.actor.orgId}/${imageId}.${ext}`;
  const cfg = {
    accountId: e.R2_ACCOUNT_ID,
    accessKeyId: e.R2_ACCESS_KEY_ID,
    secretAccessKey: e.R2_SECRET_ACCESS_KEY,
  };
  const uploadUrl = await presignPut(cfg, e.R2_PRIVATE_BUCKET, key, UPLOAD_TTL);

  const scoped = orgDbFor(auth.actor.orgId, e.DB);
  await scoped.help.createImage({
    id: imageId,
    // Library-owned by default (spec 0026); a legacy caller may still pass an articleId.
    articleId: body.articleId?.trim() || null,
    r2Key: key,
    contentType: body.contentType as string,
    uploadedBy: auth.actor.userId,
    filename: body.filename?.trim().slice(0, 200) || null,
    altText: body.alt?.trim().slice(0, 500) || null,
    width: Number.isFinite(body.width) ? Math.round(body.width as number) : null,
    height: Number.isFinite(body.height)
      ? Math.round(body.height as number)
      : null,
    sizeBytes: Number.isFinite(body.size) ? Math.round(body.size as number) : null,
  });

  return Response.json({
    ok: true,
    imageId,
    uploadUrl,
    url: `/api/help/images/${imageId}`,
  });
}
