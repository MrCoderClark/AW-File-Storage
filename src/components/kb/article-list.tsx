"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

// The Knowledge base article list (spec 0025). Fetches this org's articles + categories and
// shows a table; each row links to the editor. New article -> /kb/articles/new.

interface Article {
  id: string;
  title: string;
  categoryId: string | null;
  category: string;
  status: "draft" | "published";
  audience: "all" | "admins";
  shared: boolean;
}
interface Category {
  id: string;
  name: string;
}

export function ArticleList() {
  const [articles, setArticles] = useState<Article[] | null>(null);
  const [catName, setCatName] = useState<Record<string, string>>({});
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    try {
      const [aRes, cRes] = await Promise.all([
        fetch("/api/help/articles", { cache: "no-store" }),
        fetch("/api/help/categories", { cache: "no-store" }),
      ]);
      if (!aRes.ok) throw new Error();
      const aBody = (await aRes.json()) as { articles?: Article[] };
      const cBody = cRes.ok
        ? ((await cRes.json()) as { categories?: Category[] })
        : { categories: [] };
      const map: Record<string, string> = {};
      for (const c of cBody.categories ?? []) map[c.id] = c.name;
      setCatName(map);
      setArticles(aBody.articles ?? []);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-brand-900">Articles</h1>
          <p className="text-sm text-muted-500">
            Help articles for your staff, shown in the header Help drawer and at /help.
          </p>
        </div>
        <Link
          href="/kb/articles/new"
          className="shrink-0 rounded-[--radius-panel] bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800"
        >
          New article
        </Link>
      </div>

      {error ? (
        <div className="rounded-[--radius-panel] border border-border bg-surface p-8 text-center text-sm text-muted-500">
          <p>Couldn&apos;t load articles.</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-3 rounded-[--radius-panel] border border-border px-3 py-1 text-xs font-medium hover:bg-canvas"
          >
            Retry
          </button>
        </div>
      ) : articles === null ? (
        <p className="p-8 text-center text-sm text-muted-500">Loading…</p>
      ) : articles.length === 0 ? (
        <div className="rounded-[--radius-panel] border border-border bg-surface p-10 text-center text-sm text-muted-500">
          No articles yet. Create your first one.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-[--radius-panel] border border-border bg-surface">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-500">
                <th className="px-4 py-2.5 font-medium">Title</th>
                <th className="px-4 py-2.5 font-medium">Category</th>
                <th className="px-4 py-2.5 font-medium">Audience</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {articles.map((a) => (
                <tr key={a.id} className="hover:bg-canvas/60">
                  <td className="px-4 py-3">
                    <Link
                      href={`/kb/articles/${a.id}`}
                      className="font-medium text-slate-800 hover:underline"
                    >
                      {a.title}
                    </Link>
                    {a.shared && (
                      <span className="ml-2 rounded-full bg-brand-600/10 px-2 py-0.5 text-[11px] font-medium text-brand-600">
                        Shared
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-500">
                    {a.categoryId ? (catName[a.categoryId] ?? "—") : a.category || "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-500">
                    {a.audience === "admins" ? "Admins only" : "All members"}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={a.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: "draft" | "published" }) {
  return status === "published" ? (
    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
      Published
    </span>
  ) : (
    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
      Draft
    </span>
  );
}
