"use client";

import { useState } from "react";
import { LogsView } from "./logs-view";
import { VisitorsView } from "./visitors-view";

// The Activity page for owners/admins (spec 0030): the existing Activity Logs plus
// a new Analytics tab (the per-visitor engagement feed). Members never reach this
// component — the page renders LogsView directly for them, so they never see the
// Analytics tab (AC-7).

type Tab = "logs" | "analytics";

const TABS: { v: Tab; l: string }[] = [
  { v: "logs", l: "Activity logs" },
  { v: "analytics", l: "Analytics" },
];

export function ActivityTabs() {
  const [tab, setTab] = useState<Tab>("logs");
  return (
    <div className="w-full">
      <div
        role="tablist"
        aria-label="Activity views"
        className="mb-5 flex gap-1 border-b border-border"
      >
        {TABS.map((t) => {
          const active = tab === t.v;
          return (
            <button
              key={t.v}
              role="tab"
              type="button"
              aria-selected={active}
              onClick={() => setTab(t.v)}
              className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                active
                  ? "border-brand-600 text-brand-900"
                  : "border-transparent text-muted-500 hover:text-slate-700"
              }`}
            >
              {t.l}
            </button>
          );
        })}
      </div>
      {tab === "logs" ? <LogsView /> : <VisitorsView />}
    </div>
  );
}
