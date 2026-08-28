"use client";

// Responsive shell body (spec 0004 AC-15). At `lg` and up the rail sits inline
// beside the content. Below `lg` it collapses behind a "Panels" control and
// slides in as an overlay drawer, so the layout works down to 360px with no
// horizontal scrolling. The rail is rendered once (one data fetch) and simply
// repositioned by CSS.

import { useEffect, useState } from "react";

export function AppShellBody({
  rail,
  children,
}: {
  rail: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  // Close the drawer on Escape for keyboard users.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="relative flex flex-1">
      {/* Backdrop (below lg, when open) */}
      {open && (
        <button
          type="button"
          aria-label="Close panels"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-20 bg-black/40 lg:hidden"
        />
      )}

      {/* Rail: inline at lg+, off-canvas drawer below lg */}
      <div
        className={`fixed inset-y-0 left-0 z-30 transform transition-transform lg:static lg:z-auto lg:transform-none ${
          open ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        }`}
      >
        {rail}
      </div>

      {/* Content column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-border bg-surface px-4 py-2 lg:hidden">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-expanded={open}
            className="inline-flex items-center gap-2 rounded-[--radius-panel] border border-border px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
          >
            <PanelsIcon className="h-4 w-4" />
            Panels
          </button>
        </div>
        <main className="flex-1 bg-canvas px-4 py-6 sm:px-6 sm:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}

function PanelsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" strokeLinecap="round" />
    </svg>
  );
}
