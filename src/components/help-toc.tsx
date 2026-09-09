"use client";

import { useEffect, useState } from "react";
import type { TocItem } from "@/lib/help-toc";

// "On this page" navigation for a help article (spec 0026 polish). Renders the heading list and
// highlights the section currently in view (scroll-spy), with smooth-scroll on click. The ids it
// links to are injected server-side by buildHelpToc.

export function HelpToc({ items }: { items: TocItem[] }) {
  const [activeId, setActiveId] = useState<string | null>(items[0]?.id ?? null);

  useEffect(() => {
    const headings = items
      .map((i) => document.getElementById(i.id))
      .filter((el): el is HTMLElement => el !== null);
    if (headings.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // The topmost heading currently intersecting wins; falls back to the last one passed.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]?.target.id) setActiveId(visible[0].target.id);
      },
      // Trigger a bit below the top so the active item matches what the reader sees.
      { rootMargin: "0px 0px -70% 0px", threshold: 0 },
    );
    for (const h of headings) observer.observe(h);
    return () => observer.disconnect();
  }, [items]);

  function onClick(e: React.MouseEvent, id: string) {
    const el = document.getElementById(id);
    if (!el) return;
    e.preventDefault();
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveId(id);
    history.replaceState(null, "", `#${id}`);
  }

  return (
    <nav aria-label="On this page">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-500">
        On this page
      </h2>
      <ul className="mt-2 space-y-1 border-l border-border">
        {items.map((item) => {
          const active = item.id === activeId;
          return (
            <li key={item.id}>
              <a
                href={`#${item.id}`}
                onClick={(e) => onClick(e, item.id)}
                className={`-ml-px block border-l-2 py-0.5 text-sm transition-colors ${
                  item.level === 3 ? "pl-6" : "pl-3"
                } ${
                  active
                    ? "border-accent-500 font-medium text-accent-500"
                    : "border-transparent text-muted-500 hover:text-slate-700"
                }`}
              >
                {item.text}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
