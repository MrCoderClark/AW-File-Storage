import { getCloudflareContext } from "@opennextjs/cloudflare";
import { imageIdsIn } from "@/lib/help-format";
import { sanitizeHelpHtml } from "@/server/help-sanitize";
import { orgDbFor } from "@/server/org-db";
import { isPlatformOwner } from "@/server/platform";
import { requireApiRole } from "@/server/session";

// Update / delete one help article (spec 0024, slice 2). Owner/admin, org-scoped. The
// `shared` flag is platform-owner-only; changing it by a non-platform-owner is refused.
export const dynamic = "force-dynamic";

interface Env {
  DB: D1Database;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const body = (await req.json().catch(() => ({}))) as {
    title?: string;
    slug?: string;
    category?: string;
    categoryId?: string | null;
    tags?: string[];
    featuredImageId?: string | null;
    relatedIds?: string[];
    audience?: string;
    bodyHtml?: string;
    excerpt?: string;
    pageKey?: string;
    status?: string;
    shared?: boolean;
    sortOrder?: number;
  };

  const { env } = getCloudflareContext();
  const scoped = orgDbFor(auth.actor.orgId, (env as unknown as Env).DB);
  const existing = await scoped.help.getOwn(id);
  if (!existing) {
    return Response.json({ ok: false, error: "Article not found." }, { status: 404 });
  }

  const patch: Record<string, unknown> = { updatedBy: auth.actor.userId };
  if (body.title !== undefined) {
    const t = body.title.trim();
    if (!t) return Response.json({ ok: false, error: "A title is required." }, { status: 400 });
    patch.title = t;
  }
  if (body.slug !== undefined) patch.slug = body.slug.trim() || existing.slug;
  if (body.category !== undefined) patch.category = body.category.trim() || "General";
  if (body.categoryId !== undefined) patch.categoryId = body.categoryId?.trim() || null;
  if (body.tags !== undefined) {
    patch.tags = JSON.stringify(Array.isArray(body.tags) ? body.tags : []);
  }
  if (body.featuredImageId !== undefined) {
    patch.featuredImageId = body.featuredImageId?.trim() || null;
  }
  if (body.relatedIds !== undefined) {
    patch.relatedIds = JSON.stringify(
      Array.isArray(body.relatedIds) ? body.relatedIds : [],
    );
  }
  if (body.audience !== undefined) {
    patch.audience = body.audience === "admins" ? "admins" : "all";
  }
  if (body.excerpt !== undefined) patch.excerpt = body.excerpt.trim() || null;
  if (body.pageKey !== undefined) patch.pageKey = body.pageKey.trim() || null;
  if (body.sortOrder !== undefined) patch.sortOrder = body.sortOrder;

  let linkIds: string[] | null = null;
  if (body.bodyHtml !== undefined) {
    const clean = sanitizeHelpHtml(body.bodyHtml);
    patch.bodyHtml = clean;
    linkIds = imageIdsIn(clean);
  }
  if (body.status !== undefined) {
    const status = body.status === "published" ? "published" : "draft";
    patch.status = status;
    // Stamp published_at the first time it goes live; clear when unpublished.
    patch.publishedAt =
      status === "published" ? (existing.publishedAt ?? new Date()) : null;
    // Unpublishing/republishing is fine; no offboard semantics here.
  }
  // `shared` is platform-owner-only (spec 0024 AC-6).
  if (body.shared !== undefined) {
    if (!(await isPlatformOwner())) {
      return Response.json(
        { ok: false, error: "Only the platform owner can share articles." },
        { status: 403 },
      );
    }
    patch.shared = body.shared === true;
  }

  await scoped.help.update(
    id,
    patch as Partial<Parameters<typeof scoped.help.create>[0]>,
  );
  if (linkIds) await scoped.help.linkImages(id, linkIds);
  await scoped.audit.append({
    actorUserId: auth.actor.userId,
    action: "help.article_updated",
    targetType: "help_article",
    targetId: id,
    metadataJson: JSON.stringify({
      fields: Object.keys(patch).filter((k) => k !== "updatedBy"),
    }),
  });
  return Response.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const { env } = getCloudflareContext();
  const scoped = orgDbFor(auth.actor.orgId, (env as unknown as Env).DB);
  const existing = await scoped.help.getOwn(id);
  if (!existing) {
    return Response.json({ ok: false, error: "Article not found." }, { status: 404 });
  }
  await scoped.help.remove(id); // help_image rows cascade with the article
  await scoped.audit.append({
    actorUserId: auth.actor.userId,
    action: "help.article_deleted",
    targetType: "help_article",
    targetId: id,
    metadataJson: JSON.stringify({ title: existing.title }),
  });
  return Response.json({ ok: true });
}
