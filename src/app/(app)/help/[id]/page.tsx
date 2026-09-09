import { getCloudflareContext } from "@opennextjs/cloudflare";
import Link from "next/link";
import { notFound } from "next/navigation";
import { HelpArticleBody } from "@/components/help-article-body";
import { sanitizeHelpHtml } from "@/server/help-sanitize";
import { orgDbFor } from "@/server/org-db";
import { getActor } from "@/server/session";

// One help article (spec 0024 AC-3, upgraded to the spec 0025 mock): a breadcrumb, an optional
// featured image, a large title with the excerpt as a subtitle, a meta row, a divider, then
// typeset content with copy-able code blocks, and an "Article details" + "Related articles" rail.
// The body is sanitized on save and again here on render (defense in depth).
export const dynamic = "force-dynamic";

function fmtDate(d: Date | null): string | null {
  if (!d) return null;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// Parse a JSON string array defensively; a malformed value yields an empty list.
function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export default async function HelpArticlePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const actor = await getActor();
  if (!actor) return null;

  const { env } = getCloudflareContext();
  const scoped = orgDbFor(actor.orgId, (env as unknown as { DB: D1Database }).DB);
  const article = await scoped.help.getForReader(id, actor.canManageAny);
  if (!article) notFound();

  const safe = sanitizeHelpHtml(article.bodyHtml);
  const published = fmtDate(article.publishedAt);
  const updated = fmtDate(article.updatedAt);
  const tags = parseJsonArray(article.tags);

  // Resolve related articles to reader-visible ones, preserving the admin's chosen order
  // (dangling / not-visible ids simply drop out).
  const relatedIds = parseJsonArray(article.relatedIds);
  const relatedRows = await scoped.help.listRelatedForReader(
    relatedIds,
    actor.canManageAny,
  );
  const relatedById = new Map(relatedRows.map((r) => [r.id, r]));
  const related = relatedIds
    .map((rid) => relatedById.get(rid))
    .filter((r): r is (typeof relatedRows)[number] => Boolean(r));

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 lg:flex-row">
      {/* Main column */}
      <article className="min-w-0 flex-1">
        <nav className="flex flex-wrap items-center gap-1.5 text-sm text-muted-500">
          <Link href="/help" className="text-accent-500 hover:underline">
            All help
          </Link>
          {article.category && (
            <>
              <span aria-hidden>/</span>
              <span className="text-slate-700">{article.category}</span>
            </>
          )}
        </nav>

        {article.featuredImageId && (
          // Served through the authorized image route (own-org, or referenced by a
          // published + shared article), so a shared article's header renders cross-org.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/help/images/${article.featuredImageId}`}
            alt=""
            className="mt-5 aspect-[16/6] w-full rounded-[--radius-panel] border border-border object-cover"
          />
        )}

        <h1 className="mt-5 text-3xl font-bold tracking-tight text-brand-900">
          {article.title}
        </h1>
        {article.excerpt && (
          <p className="mt-2 text-lg text-muted-500">{article.excerpt}</p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border pb-4 text-xs text-muted-500">
          <span className="inline-flex items-center gap-1.5">
            <DotIcon /> Published
          </span>
          {published && <span>{published}</span>}
          {updated && <span>Last updated {updated}</span>}
        </div>

        <HelpArticleBody html={safe} />
      </article>

      {/* Details rail */}
      <aside className="w-full shrink-0 space-y-4 lg:w-64">
        <div className="rounded-[--radius-panel] border border-border bg-surface p-4">
          <h2 className="text-sm font-semibold text-slate-800">Article details</h2>
          <dl className="mt-3 space-y-3 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-500">
                Category
              </dt>
              <dd className="mt-0.5 text-slate-800">
                {article.category || "General"}
              </dd>
            </div>
            {tags.length > 0 && (
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-500">
                  Tags
                </dt>
                <dd className="mt-1 flex flex-wrap gap-1.5">
                  {tags.map((t) => (
                    <span
                      key={t}
                      className="rounded-full bg-accent-500/10 px-2 py-0.5 text-xs font-medium text-accent-500"
                    >
                      {t}
                    </span>
                  ))}
                </dd>
              </div>
            )}
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-500">
                Status
              </dt>
              <dd className="mt-0.5 inline-flex items-center gap-1.5 text-slate-800">
                <DotIcon /> Published
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-500">
                Visibility
              </dt>
              <dd className="mt-0.5 text-slate-800">
                {article.audience === "admins" ? "Admins only" : "Everyone"}
              </dd>
            </div>
          </dl>
        </div>

        {related.length > 0 && (
          <div className="rounded-[--radius-panel] border border-border bg-surface p-4">
            <h2 className="text-sm font-semibold text-slate-800">
              Related articles
            </h2>
            <ul className="mt-3 space-y-2">
              {related.map((r) => (
                <li key={r.id} className="flex gap-2">
                  <FileIcon className="mt-0.5 h-4 w-4 shrink-0 text-accent-500" />
                  <span className="min-w-0">
                    <Link
                      href={`/help/${r.id}`}
                      className="block text-sm text-accent-500 hover:underline"
                    >
                      {r.title}
                    </Link>
                    {r.category && (
                      <span className="text-xs text-muted-500">{r.category}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>
    </div>
  );
}

function DotIcon() {
  return (
    <span
      aria-hidden
      className="inline-block h-2 w-2 rounded-full bg-emerald-500"
    />
  );
}

function FileIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z" />
    </svg>
  );
}
