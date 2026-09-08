import { getCloudflareContext } from "@opennextjs/cloudflare";
import Link from "next/link";
import { notFound } from "next/navigation";
import { sanitizeHelpHtml } from "@/server/help-sanitize";
import { orgDbFor } from "@/server/org-db";
import { getActor } from "@/server/session";

// One help article (spec 0024 AC-3), inside the app shell. Loads a published article the
// reader may see (own org or shared) by id; 404 otherwise. The body is sanitized on save and
// again here on render (defense in depth) — this is the only dangerouslySetInnerHTML site.
export const dynamic = "force-dynamic";

export default async function HelpArticlePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const actor = await getActor();
  if (!actor) return null; // the (app) layout already gates auth

  const { env } = getCloudflareContext();
  const scoped = orgDbFor(actor.orgId, (env as unknown as { DB: D1Database }).DB);
  const article = await scoped.help.getForReader(id);
  if (!article) notFound();

  const safe = sanitizeHelpHtml(article.bodyHtml);

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/help" className="text-sm text-accent-500 hover:underline">
        ← All help
      </Link>
      <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-500">
        {article.category}
      </p>
      <h1 className="mt-1 text-2xl font-semibold text-brand-900">
        {article.title}
      </h1>
      <article
        className="help-content mt-6 rounded-[--radius-panel] border border-border bg-surface p-6 text-sm leading-relaxed text-slate-800"
        // Sanitized on save and again here (spec 0024 AC-8); the only such call site.
        dangerouslySetInnerHTML={{ __html: safe }}
      />
    </div>
  );
}
