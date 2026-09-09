"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

// The reader's help library browser (spec 0024 AC-3), styled to the knowledge-base mock
// (docs/Designs/mock-articles-list.png): category tabs, a search box + sort control, a list
// of article cards, and a right rail with a Categories list and a "Need help?" contact box.
// Reader-only: every article here is already published and visible to the viewer, so there
// are no status/audience affordances — those live in the admin editor.

// Placeholder support address (mirrors help-drawer.tsx; spec 0024 follow-up: set the real one).
const SUPPORT_EMAIL = "support@americaworks.com";

export interface BrowserArticle {
  id: string;
  title: string;
  category: string;
  excerpt: string | null;
  /** Curated order set in the editor (ascending; 0 first). */
  sortOrder: number;
  /** Last-updated time as epoch ms (0 when unknown). */
  updatedAt: number;
}

// "curated" is the admin-set order (help_article.sort_order) and is the default, so the
// order chosen in the editor (0,1,2,3…) is honoured; the rest are reader-chosen overrides.
type Sort = "curated" | "newest" | "oldest" | "az";

function fmtDate(ms: number): string | null {
  if (!ms) return null;
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function HelpBrowser({ articles }: { articles: BrowserArticle[] }) {
  const [query, setQuery] = useState("");
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("curated");

  // Categories with counts, derived from the visible articles (stable, independent of the
  // current search/filter), ordered by count then name.
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of articles) counts.set(a.category, (counts.get(a.category) ?? 0) + 1);
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [articles]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = articles.filter((a) => {
      if (activeCat && a.category !== activeCat) return false;
      if (!q) return true;
      return (
        a.title.toLowerCase().includes(q) ||
        a.excerpt?.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q)
      );
    });
    list = [...list].sort((a, b) => {
      if (sort === "az") return a.title.localeCompare(b.title);
      if (sort === "oldest") return a.updatedAt - b.updatedAt;
      if (sort === "newest") return b.updatedAt - a.updatedAt;
      // curated: the admin-set order (0 first), tie-broken by title.
      return a.sortOrder - b.sortOrder || a.title.localeCompare(b.title);
    });
    return list;
  }, [articles, query, activeCat, sort]);

  return (
    <div className="mx-auto max-w-6xl">
      <p className="text-xs font-semibold uppercase tracking-wide text-accent-500">
        Knowledge base
      </p>
      <h1 className="mt-1 text-2xl font-bold text-brand-900">
        Help &amp; documentation
      </h1>
      <p className="mt-1 text-sm text-muted-500">
        Browse and search guides for using AW File Storage.
      </p>

      <div className="mt-6 flex flex-col gap-8 lg:flex-row">
        {/* Main column */}
        <div className="min-w-0 flex-1">
          {/* Category tabs */}
          {categories.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <Tab
                label="All articles"
                count={articles.length}
                active={activeCat === null}
                onClick={() => setActiveCat(null)}
              />
              {categories.map((c) => (
                <Tab
                  key={c.name}
                  label={c.name}
                  count={c.count}
                  active={activeCat === c.name}
                  onClick={() => setActiveCat(c.name)}
                />
              ))}
            </div>
          )}

          {/* Search + sort */}
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-500" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search articles by title or content…"
                className="w-full rounded-[--radius-panel] border border-border bg-surface py-2 pl-9 pr-3 text-sm text-slate-800 placeholder:text-muted-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
              />
            </div>
            <label className="relative shrink-0">
              <span className="sr-only">Sort articles</span>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as Sort)}
                className="h-full rounded-[--radius-panel] border border-border bg-surface py-2 pl-3 pr-8 text-sm font-medium text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
              >
                <option value="curated">Recommended order</option>
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
                <option value="az">Title A–Z</option>
              </select>
            </label>
          </div>

          {/* Article cards */}
          <div className="mt-4 space-y-3">
            {articles.length === 0 ? (
              <EmptyState>No help articles yet.</EmptyState>
            ) : visible.length === 0 ? (
              <EmptyState>No articles match your search.</EmptyState>
            ) : (
              visible.map((a) => <ArticleCard key={a.id} a={a} />)
            )}
          </div>
        </div>

        {/* Right rail */}
        <aside className="w-full shrink-0 space-y-4 lg:w-72">
          <div className="overflow-hidden rounded-[--radius-panel] border border-border bg-surface">
            <h2 className="flex items-center gap-2 border-b border-border px-4 py-3 text-sm font-semibold text-slate-800">
              <FolderIcon className="h-4 w-4 text-muted-500" />
              Categories
            </h2>
            <ul className="p-2">
              <CategoryRow
                label="All articles"
                count={articles.length}
                active={activeCat === null}
                onClick={() => setActiveCat(null)}
              />
              {categories.map((c) => (
                <CategoryRow
                  key={c.name}
                  label={c.name}
                  count={c.count}
                  active={activeCat === c.name}
                  onClick={() => setActiveCat(c.name)}
                />
              ))}
            </ul>
          </div>

          <div className="rounded-[--radius-panel] border border-border bg-accent-500/5 p-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <InfoIcon className="h-4 w-4 text-accent-500" />
              Need help?
            </h2>
            <p className="mt-1.5 text-sm text-muted-500">
              Can&apos;t find what you&apos;re looking for? Reach out to the support team.
            </p>
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-accent-500 hover:underline"
            >
              <MailIcon className="h-4 w-4" />
              Contact support
            </a>
          </div>
        </aside>
      </div>
    </div>
  );
}

function ArticleCard({ a }: { a: BrowserArticle }) {
  const updated = fmtDate(a.updatedAt);
  return (
    <Link
      href={`/help/${a.id}`}
      className="group flex gap-4 rounded-[--radius-panel] border border-border bg-surface p-4 transition-colors hover:border-accent-500/40 hover:bg-canvas/60"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[--radius-panel] bg-accent-500/10 text-accent-500">
        <DocIcon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold text-slate-800 group-hover:text-accent-500">
          {a.title}
        </h3>
        {a.excerpt && (
          <p className="mt-1 line-clamp-2 text-sm text-muted-500">{a.excerpt}</p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-500">
          <span className="inline-flex items-center gap-1.5">
            <FolderIcon className="h-3.5 w-3.5" />
            {a.category}
          </span>
          {updated && (
            <span className="inline-flex items-center gap-1.5">
              <ClockIcon className="h-3.5 w-3.5" />
              Updated {updated}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}

function Tab({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-2 rounded-[--radius-panel] px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 ${
        active
          ? "bg-brand-600 text-white"
          : "border border-border bg-surface text-slate-700 hover:bg-canvas"
      }`}
    >
      {label}
      <span
        className={`rounded-full px-1.5 text-xs font-semibold ${
          active ? "bg-white/20 text-white" : "bg-canvas text-muted-500"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

function CategoryRow({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? "true" : undefined}
        className={`flex w-full items-center justify-between gap-2 rounded-[--radius-panel] px-2.5 py-2 text-sm transition-colors ${
          active
            ? "bg-accent-500/10 font-medium text-accent-500"
            : "text-slate-700 hover:bg-canvas"
        }`}
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          <FolderIcon
            className={`h-4 w-4 shrink-0 ${active ? "text-accent-500" : "text-muted-500"}`}
          />
          <span className="truncate">{label}</span>
        </span>
        <span className="shrink-0 text-xs font-semibold text-muted-500">{count}</span>
      </button>
    </li>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-[--radius-panel] border border-border bg-surface p-8 text-center text-sm text-muted-500">
      {children}
    </p>
  );
}

/* --- Icons (inline, stroke-based to match the shell) --- */

function iconProps(className?: string) {
  return {
    className,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
}

function DocIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z" />
      <path d="M9 9h1M9 13h6M9 17h6" />
    </svg>
  );
}

function FolderIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2Z" />
    </svg>
  );
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function InfoIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}

function MailIcon({ className }: { className?: string }) {
  return (
    <svg {...iconProps(className)}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  );
}
