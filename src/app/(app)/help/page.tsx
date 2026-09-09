import { getCloudflareContext } from "@opennextjs/cloudflare";
import { HelpBrowser, type BrowserArticle } from "@/components/help-browser";
import { orgDbFor } from "@/server/org-db";
import { getActor } from "@/server/session";

// The full help library (spec 0024 AC-3), inside the app shell. Lists the reader's visible
// published articles (own org plus shared) as a searchable, filterable card browser matching
// the knowledge-base mock: category tabs, search + sort, and a Categories / Need-help rail.
export const dynamic = "force-dynamic";

export default async function HelpPage() {
  const actor = await getActor();
  if (!actor) return null; // the (app) layout already gates auth

  const { env } = getCloudflareContext();
  const scoped = orgDbFor(actor.orgId, (env as unknown as { DB: D1Database }).DB);
  const rows = await scoped.help.listForReader({
    viewerIsAdmin: actor.canManageAny,
  });

  // Serialize to a client-safe shape (Dates → epoch ms + a formatted label).
  const articles: BrowserArticle[] = rows.map((a) => ({
    id: a.id,
    title: a.title,
    category: a.category || "General",
    excerpt: a.excerpt ?? null,
    sortOrder: a.sortOrder ?? 0,
    updatedAt: a.updatedAt ? new Date(a.updatedAt).getTime() : 0,
  }));

  return <HelpBrowser articles={articles} />;
}
