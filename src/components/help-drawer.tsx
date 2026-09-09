"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ContactSupport } from "@/components/contact-support";

// The header help launcher (spec 0024): a "?" button that opens a slide-over Help drawer.
// The drawer loads the reader feed (GET /api/help), offers search, a "For this page"
// contextual list, a browse-by-category list, a link to the full /help page, and a
// contact-support form (a modal that emails support). Reading only; authoring lives in the KB.
//
// The panel stays mounted and animates open/closed (slide + backdrop fade) so it never
// flashes; a global prefers-reduced-motion rule neutralises the motion for those who ask.

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
      <HelpDrawer open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function HelpDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);
  const [articles, setArticles] = useState<Article[] | null>(null);
  const [error, setError] = useState(false);
  const [q, setQ] = useState("");
  const pageKey = pageKeyFromPath(pathname ?? "");
  // Refs, not state, so starting the fetch never re-runs the effect (which would tear it
  // down mid-flight and lose the result). `started` guards against a second fetch; `alive`
  // flips only on real unmount, so closing the drawer never cancels an in-flight load.
  const started = useRef(false);
  const alive = useRef(true);

  // Portal target only exists in the browser.
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    // Set on (re)mount and clear on unmount. StrictMode dev-mounts twice, so restoring
    // this to true on the second mount is required or the fetch's result gets dropped.
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Lazy-load the feed the first time the drawer is opened.
  useEffect(() => {
    if (!open || started.current) return;
    started.current = true;
    fetch("/api/help", { cache: "no-store" })
      .then((r) =>
        r.ok
          ? (r.json() as Promise<{ articles?: Article[] }>)
          : Promise.reject(new Error()),
      )
      .then((b) => {
        if (alive.current) setArticles(b.articles ?? []);
      })
      .catch(() => {
        if (alive.current) {
          setError(true);
          started.current = false; // allow a retry the next time it opens
        }
      });
  }, [open]);

  // Esc closes, only while open.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!mounted) return null;

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
      className={`fixed inset-0 z-50 ${open ? "" : "pointer-events-none"}`}
      aria-hidden={!open}
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close help"
        tabIndex={-1}
        onClick={onClose}
        className={`absolute inset-0 cursor-default bg-slate-900/40 transition-opacity duration-200 ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />
      {/* Panel */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Help"
        className={`absolute right-0 top-0 flex h-full w-full max-w-sm flex-col bg-surface shadow-xl transition-transform duration-200 ease-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
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
          <ContactSupport className="mt-1 block w-full rounded-[--radius-panel] px-2 py-1.5 text-left text-slate-700 hover:bg-canvas">
            Contact support
          </ContactSupport>
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
