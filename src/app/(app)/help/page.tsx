import { getCloudflareContext } from "@opennextjs/cloudflare";
import Link from "next/link";
import { orgDbFor } from "@/server/org-db";
import { getActor } from "@/server/session";

// The full help library (spec 0024 AC-3), inside the app shell. Lists the reader's visible
// published articles (own org plus shared) grouped by category; links to each article by id.
export const dynamic = "force-dynamic";

interface ReaderArticle {
  id: string;
  title: string;
  category: string;
  excerpt: string | null;
}

export default async function HelpPage() {
  const actor = await getActor();
  if (!actor) return null; // the (app) layout already gates auth

  const { env } = getCloudflareContext();
  const scoped = orgDbFor(actor.orgId, (env as unknown as { DB: D1Database }).DB);
  const articles = (await scoped.help.listForReader()) as ReaderArticle[];

  const groups = new Map<string, ReaderArticle[]>();
  for (const a of articles) {
    const key = a.category || "General";
    const bucket = groups.get(key);
    if (bucket) bucket.push(a);
    else groups.set(key, [a]);
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold text-brand-900">
        Help &amp; documentation
      </h1>
      <p className="mt-1 text-sm text-muted-500">
        Guides for using AW File Storage.
      </p>

      {articles.length === 0 ? (
        <p className="mt-8 rounded-[--radius-panel] border border-border bg-surface p-8 text-center text-sm text-muted-500">
          No help articles yet.
        </p>
      ) : (
        <div className="mt-6 space-y-6">
          {[...groups.entries()].map(([cat, items]) => (
            <section
              key={cat}
              className="overflow-hidden rounded-[--radius-panel] border border-border bg-surface"
            >
              <h2 className="border-b border-border px-4 py-2.5 text-sm font-semibold text-slate-800">
                {cat}
              </h2>
              <ul className="divide-y divide-border">
                {items.map((a) => (
                  <li key={a.id}>
                    <Link
                      href={`/help/${a.id}`}
                      className="block px-4 py-3 hover:bg-canvas"
                    >
                      <span className="block text-sm font-medium text-slate-800">
                        {a.title}
                      </span>
                      {a.excerpt && (
                        <span className="mt-0.5 block text-xs text-muted-500">
                          {a.excerpt}
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
