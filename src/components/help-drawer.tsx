"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

// The header help launcher (spec 0024): a "?" button that opens a slide-over Help drawer.
// The drawer loads the reader feed (GET /api/help), offers search, a "For this page"
// contextual list, a browse-by-category list, a link to the full /help page, and a
// contact-support mailto. Reading only; authoring lives in Settings (slice 2).

// Placeholder support address (spec 0024 follow-up: set the real one).
const SUPPORT_EMAIL = "support@americaworks.com";

interface Article {
  id: string;
  title: string;
  category: string;
  excerpt: string | null;
  pageKey: string | null;
}

// A stable per-route key for contextual help, from the first path segment
// (e.g. /files → "files", /settings/members → "settings"). Matches help_article.page_key.
function pageKeyFromPath(path: string): string {
  const seg = path.replace(/^\/+/, "").split("/")[0];
  return seg || "dashboard";
}

export function HelpLauncher() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label="Help"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="relative rounded-full p-1.5 hover:bg-white/10"
      >
        <HelpIcon className="h-5 w-5" />
      </button>
      {open && <HelpDrawer onClose={() => setOpen(false)} />}
    </>
  );
}

function HelpDrawer({ onClose }: { onClose: () => void }) {
  const pathname = usePathname();
  const [articles, setArticles] = useState<Article[] | null>(null);
  const [error, setError] = useState(false);
  const [q, setQ] = useState("");
  const pageKey = pageKeyFromPath(pathname ?? "");

  useEffect(() => {
    let alive = true;
    fetch("/api/help", { cache: "no-store" })
      .then((r) =>
        r.ok
          ? (r.json() as Promise<{ articles?: Article[] }>)
          : Promise.reject(new Error()),
      )
      .then((b) => {
        if (alive) setArticles(b.articles ?? []);
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const all = articles ?? [];
  const term = q.trim().toLowerCase();
  // Search over plain-text fields only (no HTML), so search is not an injection surface.
  const filtered = term
    ? all.filter(
        (a) =>
          a.title.toLowerCase().includes(term) ||
          (a.excerpt ?? "").toLowerCase().includes(term) ||
          a.category.toLowerCase().includes(term),
      )
    : all;
  const contextual = term ? [] : all.filter((a) => a.pageKey === pageKey);
  const grouped = groupByCategory(filtered);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-label="Help"
    >
      <button
        type="button"
        aria-label="Close help"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-slate-900/40"
      />
      <aside className="relative flex h-full w-full max-w-sm flex-col bg-surface shadow-xl">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold text-brand-900">Help</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded p-1 text-muted-500 hover:bg-canvas"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </header>

        <div className="border-b border-border p-3">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search help"
            aria-label="Search help"
            className="w-full rounded-[--radius-panel] border border-border bg-canvas px-3 py-1.5 text-sm focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/25"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {error ? (
            <p className="p-4 text-center text-sm text-muted-500">
              Couldn&apos;t load help.
            </p>
          ) : articles === null ? (
            <p className="p-4 text-center text-sm text-muted-500">Loading…</p>
          ) : all.length === 0 ? (
            <p className="p-4 text-center text-sm text-muted-500">
              No help articles yet.
            </p>
          ) : (
            <>
              {contextual.length > 0 && (
                <section className="mb-4">
                  <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-500">
                    For this page
                  </h3>
                  <ul className="space-y-1">
                    {contextual.map((a) => (
                      <ArticleRow key={a.id} a={a} onClose={onClose} />
                    ))}
                  </ul>
                </section>
              )}
              {grouped.map(([cat, items]) => (
                <section key={cat} className="mb-4">
                  <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-500">
                    {cat}
                  </h3>
                  <ul className="space-y-1">
                    {items.map((a) => (
                      <ArticleRow key={a.id} a={a} onClose={onClose} />
                    ))}
                  </ul>
                </section>
              ))}
              {filtered.length === 0 && (
                <p className="p-4 text-center text-sm text-muted-500">
                  No matches.
                </p>
              )}
            </>
          )}
        </div>

        <footer className="border-t border-border p-3 text-sm">
          <Link
            href="/help"
            onClick={onClose}
            className="block rounded-[--radius-panel] px-2 py-1.5 font-medium text-accent-500 hover:bg-canvas"
          >
            Open full help →
          </Link>
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="mt-1 block rounded-[--radius-panel] px-2 py-1.5 text-slate-700 hover:bg-canvas"
          >
            Contact support
          </a>
        </footer>
      </aside>
    </div>,
    document.body,
  );
}

function ArticleRow({ a, onClose }: { a: Article; onClose: () => void }) {
  return (
    <li>
      <Link
        href={`/help/${a.id}`}
        onClick={onClose}
        className="block rounded-[--radius-panel] px-2 py-1.5 hover:bg-canvas"
      >
        <span className="block text-sm font-medium text-slate-800">{a.title}</span>
        {a.excerpt && (
          <span className="block truncate text-xs text-muted-500">{a.excerpt}</span>
        )}
      </Link>
    </li>
  );
}

function groupByCategory(items: Article[]): [string, Article[]][] {
  const map = new Map<string, Article[]>();
  for (const a of items) {
    const key = a.category || "General";
    const bucket = map.get(key);
    if (bucket) bucket.push(a);
    else map.set(key, [a]);
  }
  return [...map.entries()];
}

function HelpIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path
        d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.3-3 4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M12 17h.01" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  );
}
