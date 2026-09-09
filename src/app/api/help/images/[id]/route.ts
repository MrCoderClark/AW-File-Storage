import { getCloudflareContext } from "@opennextjs/cloudflare";
import { orgDbFor } from "@/server/org-db";
import { r2Delete, r2GetBytes } from "@/server/r2";
import { getActor, requireApiRole } from "@/server/session";

// Serve a help image (spec 0024 AC-7). AUTHORIZED, not merely login-gated: the image is
// returned only if it belongs to the caller's org OR it is referenced by a published+shared
// article (the getServableImage check). Bytes stream through the Worker so authorization runs
// on every request (a presigned URL would leak past it). Served from the PRIVATE bucket.
// PATCH renames / edits alt text; DELETE removes an image (spec 0026), refused while any article
// still uses it. Both are admin/owner + org-scoped.
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

// Rename an image or edit its alt text (spec 0026 AC-4). Admin/owner, org-scoped.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const body = (await req.json().catch(() => ({}))) as {
    filename?: string;
    title?: string | null;
    caption?: string | null;
    alt?: string | null;
  };
  const patch: {
    filename?: string;
    title?: string | null;
    caption?: string | null;
    altText?: string | null;
  } = {};
  if (body.filename !== undefined) patch.filename = body.filename.trim().slice(0, 200);
  if (body.title !== undefined)
    patch.title = body.title === null ? null : body.title.trim().slice(0, 200) || null;
  if (body.caption !== undefined)
    patch.caption =
      body.caption === null ? null : body.caption.trim().slice(0, 1000) || null;
  if (body.alt !== undefined)
    patch.altText = body.alt === null ? null : body.alt.trim().slice(0, 500) || null;

  const { env } = getCloudflareContext();
  const e = env as unknown as Env;
  const scoped = orgDbFor(auth.actor.orgId, e.DB);
  const updated = await scoped.help.updateImage(id, patch);
  if (!updated) return Response.json({ ok: false, error: "Not found." }, { status: 404 });
  return Response.json({ ok: true });
}

// Delete an image (spec 0026 AC-6). Refused (409) while any article references it, returning the
// referencing articles so the admin can unlink first. Otherwise removes the row and R2 object.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const { env } = getCloudflareContext();
  const e = env as unknown as Env;
  const scoped = orgDbFor(auth.actor.orgId, e.DB);

  const img = await scoped.help.getImage(id);
  if (!img) return Response.json({ ok: false, error: "Not found." }, { status: 404 });

  const usedBy = await scoped.help.referencingArticles(id);
  if (usedBy.length > 0) {
    return Response.json(
      { ok: false, error: "This image is still used by an article.", articles: usedBy },
      { status: 409 },
    );
  }

  await r2Delete(
    {
      accountId: e.R2_ACCOUNT_ID,
      accessKeyId: e.R2_ACCESS_KEY_ID,
      secretAccessKey: e.R2_SECRET_ACCESS_KEY,
    },
    e.R2_PRIVATE_BUCKET,
    img.r2Key,
  );
  await scoped.help.removeImage(id);
  return Response.json({ ok: true });
}
