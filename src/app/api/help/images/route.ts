import { getCloudflareContext } from "@opennextjs/cloudflare";
import { uuidv7 } from "@/server/id";
import { orgDbFor } from "@/server/org-db";
import { presignPut } from "@/server/r2";
import { requireApiRole } from "@/server/session";

// Reserve a help image upload (spec 0024 AC-7). Owner/admin. Returns a presigned PUT to the
// PRIVATE bucket (bytes go straight to R2, like the file uploader) plus the app-relative serve
// URL to embed in the article body. The help_image row records the owning org and (optionally)
// the article; save-time linking (articles route) sets article_id for new articles.
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

export async function POST(req: Request) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => ({}))) as {
    contentType?: string;
    articleId?: string;
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
    articleId: body.articleId?.trim() || null,
    r2Key: key,
    contentType: body.contentType as string,
    uploadedBy: auth.actor.userId,
  });

  return Response.json({
    ok: true,
    imageId,
    uploadUrl,
    url: `/api/help/images/${imageId}`,
  });
}
