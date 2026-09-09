import { getCloudflareContext } from "@opennextjs/cloudflare";
import { notFound } from "next/navigation";
import { ArticleEditor, type EditorArticle } from "@/components/kb/article-editor";
import { orgDbFor } from "@/server/org-db";
import { getActor } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function EditArticlePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const actor = await getActor();
  if (!actor) return null; // the kb layout already gates admin/owner

  const { env } = getCloudflareContext();
  const scoped = orgDbFor(actor.orgId, (env as unknown as { DB: D1Database }).DB);
  const a = await scoped.help.getOwn(id);
  if (!a) notFound();

  const article: EditorArticle = {
    id: a.id,
    title: a.title,
    slug: a.slug,
    categoryId: a.categoryId,
    tags: a.tags,
    featuredImageId: a.featuredImageId,
    relatedIds: a.relatedIds,
    audience: a.audience,
    bodyHtml: a.bodyHtml,
    excerpt: a.excerpt,
    pageKey: a.pageKey,
    status: a.status,
    shared: a.shared,
    sortOrder: a.sortOrder,
  };
  return <ArticleEditor article={article} />;
}
