import { getCloudflareContext } from "@opennextjs/cloudflare";
import { helpSlugify, imageIdsIn } from "@/lib/help-format";
import { sanitizeHelpHtml } from "@/server/help-sanitize";
import { orgDbFor } from "@/server/org-db";
import { isPlatformOwner } from "@/server/platform";
import { requireApiRole } from "@/server/session";

// Admin help-article endpoints (spec 0024, slice 2). Owner/admin, org-scoped. The `shared`
// flag is platform-owner-only. Body HTML is sanitized on save; embedded image ids are linked
// to the article so a shared article's images resolve cross-org (AC-7).
export const dynamic = "force-dynamic";

interface Env {
  DB: D1Database;
}

// GET: this org's own articles (any status) for the editor list, plus whether the caller may
// share (platform owner).
export async function GET() {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { env } = getCloudflareContext();
  const scoped = orgDbFor(auth.actor.orgId, (env as unknown as Env).DB);
  const articles = await scoped.help.listOwn();
  return Response.json({ ok: true, articles, canShare: await isPlatformOwner() });
}

// POST: create an article (defaults to draft). Owner/admin.
export async function POST(req: Request) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => ({}))) as {
    title?: string;
    slug?: string;
    category?: string;
    categoryId?: string;
    tags?: string[];
    featuredImageId?: string;
    relatedIds?: string[];
    audience?: string;
    bodyHtml?: string;
    excerpt?: string;
    pageKey?: string;
    status?: string;
    shared?: boolean;
  };
  const title = body.title?.trim();
  if (!title) {
    return Response.json({ ok: false, error: "A title is required." }, { status: 400 });
  }
  const status = body.status === "published" ? "published" : "draft";
  // Only the platform owner may share (spec 0024 AC-6).
  const shared = body.shared === true && (await isPlatformOwner());
  const bodyHtml = sanitizeHelpHtml(body.bodyHtml ?? "");

  const { env } = getCloudflareContext();
  const scoped = orgDbFor(auth.actor.orgId, (env as unknown as Env).DB);
  const article = await scoped.help.create({
    title,
    slug: body.slug?.trim() || helpSlugify(title),
    category: body.category?.trim() || "General",
    categoryId: body.categoryId?.trim() || null,
    tags: JSON.stringify(Array.isArray(body.tags) ? body.tags : []),
    featuredImageId: body.featuredImageId?.trim() || null,
    relatedIds: JSON.stringify(Array.isArray(body.relatedIds) ? body.relatedIds : []),
    audience: body.audience === "admins" ? "admins" : "all",
    bodyHtml,
    excerpt: body.excerpt?.trim() || null,
    pageKey: body.pageKey?.trim() || null,
    status,
    shared,
    publishedAt: status === "published" ? new Date() : null,
    updatedBy: auth.actor.userId,
  });
  await scoped.help.linkImages(article.id, imageIdsIn(bodyHtml));
  await scoped.audit.append({
    actorUserId: auth.actor.userId,
    action: "help.article_created",
    targetType: "help_article",
    targetId: article.id,
    metadataJson: JSON.stringify({ title, status, shared }),
  });
  return Response.json({ ok: true, id: article.id });
}
