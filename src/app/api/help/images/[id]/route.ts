import { getCloudflareContext } from "@opennextjs/cloudflare";
import { orgDbFor } from "@/server/org-db";
import { r2GetBytes } from "@/server/r2";
import { getActor } from "@/server/session";

// Serve a help image (spec 0024 AC-7). AUTHORIZED, not merely login-gated: the image is
// returned only if it belongs to the caller's org OR it is referenced by a published+shared
// article (the getServableImage check). Bytes stream through the Worker so authorization runs
// on every request (a presigned URL would leak past it). Served from the PRIVATE bucket.
export const dynamic = "force-dynamic";

interface Env {
  DB: D1Database;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_PRIVATE_BUCKET: string;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActor();
  if (!actor) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;

  const { env } = getCloudflareContext();
  const e = env as unknown as Env;
  const scoped = orgDbFor(actor.orgId, e.DB);
  const img = await scoped.help.getServableImage(id);
  if (!img) return new Response("Not found", { status: 404 });

  const obj = await r2GetBytes(
    {
      accountId: e.R2_ACCOUNT_ID,
      accessKeyId: e.R2_ACCESS_KEY_ID,
      secretAccessKey: e.R2_SECRET_ACCESS_KEY,
    },
    e.R2_PRIVATE_BUCKET,
    img.r2Key,
  );
  if (!obj) return new Response("Not found", { status: 404 });

  return new Response(obj.body, {
    headers: {
      "Content-Type": img.contentType || obj.contentType || "application/octet-stream",
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
