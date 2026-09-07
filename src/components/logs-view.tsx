"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LogCategory } from "@/lib/log-format";

// Admin Activity Logs (spec 0018): a filtered, paginated, professional read view over
// the org's audit trail — every publish, member change, and O365 onboard/offboard.

interface Row {
  id: string;
  at: number;
  category: LogCategory;
  eventType: string;
  action: string;
  status: "success" | "failed";
  actor: string;
  detail: string;
  targetType: string;
  metadata: string | null;
}
interface Stats {
  totalToday: number;
  o365SuccessRate: number;
  activeVcards: number;
}

const RANGES = [
  { v: "1", l: "Last 24 hours" },
  { v: "7", l: "Last 7 days" },
  { v: "30", l: "Last 30 days" },
  { v: "all", l: "All time" },
];

const CHIPS: { v: string; l: string }[] = [
  { v: "", l: "All logs" },
  { v: "vcard", l: "VCard Gen" },
  { v: "onboard", l: "Onboarding" },
  { v: "offboard", l: "Offboarding" },
  { v: "error", l: "Sync errors" },
];

// Literal class strings (Tailwind JIT needs them whole) per event category.
const BADGE: Record<LogCategory, string> = {
  vcard: "bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-600/20",
  onboard: "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-600/20",
  offboard: "bg-red-50 text-red-700 ring-1 ring-inset ring-red-600/20",
  sync: "bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-500/20",
  error: "bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-600/30",
  user: "bg-indigo-50 text-indigo-700 ring-1 ring-inset ring-indigo-600/20",
  file: "bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-500/20",
  other: "bg-slate-100 text-slate-500 ring-1 ring-inset ring-slate-400/20",
};

// New York Eastern time, formatted MM-DD-YYYY h:mmAM/PM (e.g. 09-07-2026 5:20PM).
const ET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "2-digit",
  day: "2-digit",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});
function fmtEastern(ms: number): string {
  const parts: Record<string, string> = {};
  for (const p of ET_FMT.formatToParts(new Date(ms))) parts[p.type] = p.value;
  return `${parts.month}-${parts.day}-${parts.year} ${parts.hour}:${parts.minute}${parts.dayPeriod}`;
}

export function LogsView() {
  const [rows, setRows] = useState<Row[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [range, setRange] = useState("7");
  const [category, setCategory] = useState("");
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const reqId = useRef(0);

  // Debounce the search box.
  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(
    async (cursor: string | null) => {
      const mine = ++reqId.current;
      if (cursor) setLoadingMore(true);
      else setLoading(true);
      setError("");
      try {
        const p = new URLSearchParams({ range });
        if (category) p.set("category", category);
        if (qDebounced.trim()) p.set("q", qDebounced.trim());
        if (cursor) p.set("cursor", cursor);
        const res = await fetch(`/api/logs?${p.toString()}`, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as {
          rows: Row[];
          nextCursor: string | null;
          stats?: Stats;
        };
        if (mine !== reqId.current) return; // a newer request superseded this one
        setRows((prev) => (cursor ? [...prev, ...body.rows] : body.rows));
        setNextCursor(body.nextCursor);
        if (body.stats) setStats(body.stats);
      } catch {
        if (mine === reqId.current) setError("Could not load activity logs.");
      } finally {
        if (mine === reqId.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [range, category, qDebounced],
  );

  // Reload from the top whenever a filter changes.
  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-brand-900">Activity logs</h1>
          <p className="mt-1 text-sm text-muted-500">
            Every action in your organization — publishes, member changes, and Office
            365 onboarding and offboarding.
          </p>
        </div>
        <div className="flex gap-5">
          <Stat label="Logs today" value={stats ? stats.totalToday.toLocaleString() : "—"} />
          <Stat
            label="O365 success"
            value={stats ? `${(stats.o365SuccessRate * 100).toFixed(1)}%` : "—"}
            tone="ok"
          />
          <Stat
            label="Active vCards"
            value={stats ? stats.activeVcards.toLocaleString() : "—"}
          />
        </div>
      </div>

      <div className="mt-5 overflow-hidden rounded-[--radius-panel] border border-border bg-surface">
        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <select
            value={range}
            onChange={(e) => setRange(e.target.value)}
            className="rounded-md border border-border bg-canvas px-2.5 py-1.5 text-sm text-slate-700"
          >
            {RANGES.map((r) => (
              <option key={r.v} value={r.v}>
                {r.l}
              </option>
            ))}
          </select>
          <div className="flex flex-wrap gap-1">
            {CHIPS.map((c) => {
              const active = category === c.v;
              return (
                <button
                  key={c.v}
                  type="button"
                  onClick={() => setCategory(c.v)}
                  className={`rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors ${
                    active
                      ? "bg-brand-600 text-white"
                      : "border border-border text-slate-600 hover:bg-canvas"
                  }`}
                >
                  {c.l}
                </button>
              );
            })}
          </div>
          <div className="ml-auto">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search logs…"
              className="w-56 rounded-md border border-border bg-canvas px-3 py-1.5 text-sm"
            />
          </div>
        </div>

        {/* Content: a shared loading/empty state, then a table (md+) or stacked
            cards (below md), so nothing ever clips or needs horizontal scrolling. */}
        {loading ? (
          <div className="px-4 py-12 text-center text-sm text-muted-500">
            Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-muted-500">
            {error || "No activity for these filters."}
          </div>
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[680px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border bg-canvas/60 text-left text-xs font-semibold uppercase tracking-wide text-muted-500">
                    <th className="px-4 py-2.5 font-semibold">Timestamp</th>
                    <th className="px-4 py-2.5 font-semibold">Event type</th>
                    <th className="px-4 py-2.5 font-semibold">User / initiator</th>
                    <th className="px-4 py-2.5 font-semibold">Details</th>
                    <th className="px-4 py-2.5 font-semibold">Status</th>
                    <th className="px-4 py-2.5 font-semibold" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <RowItem
                      key={r.id}
                      row={r}
                      open={expanded === r.id}
                      onToggle={() =>
                        setExpanded((cur) => (cur === r.id ? null : r.id))
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>

            <div className="divide-y divide-border/70 md:hidden">
              {rows.map((r) => (
                <LogCard
                  key={r.id}
                  row={r}
                  open={expanded === r.id}
                  onToggle={() =>
                    setExpanded((cur) => (cur === r.id ? null : r.id))
                  }
                />
              ))}
            </div>
          </>
        )}

        {nextCursor && !loading && (
          <div className="border-t border-border p-3 text-center">
            <button
              type="button"
              onClick={() => void load(nextCursor)}
              disabled={loadingMore}
              className="rounded-md border border-border px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-canvas disabled:opacity-50"
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </div>
      {error && rows.length > 0 && (
        <p className="mt-2 text-xs text-danger-600">{error}</p>
      )}
    </div>
  );
}

function RowItem({
  row,
  open,
  onToggle,
}: {
  row: Row;
  open: boolean;
  onToggle: () => void;
}) {
  let pretty = "";
  if (row.metadata) {
    try {
      pretty = JSON.stringify(JSON.parse(row.metadata), null, 2);
    } catch {
      pretty = row.metadata;
    }
  }
  return (
    <>
      <tr className="border-b border-border/70 last:border-0 hover:bg-canvas/50">
        <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-slate-500">
          {fmtEastern(row.at)}
        </td>
        <td className="px-4 py-3">
          <span
            className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${BADGE[row.category]}`}
          >
            {row.eventType}
          </span>
        </td>
        <td className="whitespace-nowrap px-4 py-3 text-slate-700">{row.actor}</td>
        <td className="px-4 py-3 text-slate-700 [overflow-wrap:anywhere]">
          <span className="font-medium text-slate-800">{row.action}</span>
          {row.detail && (
            <span className="text-muted-500"> — {row.detail}</span>
          )}
        </td>
        <td className="px-4 py-3">
          {row.status === "failed" ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-danger-600">
              <span className="h-1.5 w-1.5 rounded-full bg-danger-600" /> Failed
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Success
            </span>
          )}
        </td>
        <td className="px-4 py-3 text-right">
          <button
            type="button"
            onClick={onToggle}
            className="text-xs font-medium text-brand-700 hover:underline"
          >
            {open ? "Hide" : "View details"}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-border/70 bg-canvas/40">
          <td colSpan={6} className="px-4 py-3">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs text-slate-600">
              <dt className="text-muted-500">Target</dt>
              <dd className="text-slate-700">
                {row.targetType}
                {row.detail ? ` · ${row.detail}` : ""}
              </dd>
              <dt className="text-muted-500">Metadata</dt>
              <dd>
                <pre className="max-h-48 overflow-auto rounded bg-slate-900/[0.03] p-2 font-mono text-[11px] leading-snug text-slate-700">
                  {pretty || "—"}
                </pre>
              </dd>
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}

// Stacked card for one log on small screens (below md), where a 6-column table would
// clip or need horizontal scrolling.
function LogCard({
  row,
  open,
  onToggle,
}: {
  row: Row;
  open: boolean;
  onToggle: () => void;
}) {
  let pretty = "";
  if (row.metadata) {
    try {
      pretty = JSON.stringify(JSON.parse(row.metadata), null, 2);
    } catch {
      pretty = row.metadata;
    }
  }
  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <span
          className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${BADGE[row.category]}`}
        >
          {row.eventType}
        </span>
        {row.status === "failed" ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-danger-600">
            <span className="h-1.5 w-1.5 rounded-full bg-danger-600" /> Failed
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Success
          </span>
        )}
      </div>
      <p className="mt-2 text-sm text-slate-800 [overflow-wrap:anywhere]">
        <span className="font-medium">{row.action}</span>
        {row.detail && <span className="text-muted-500"> — {row.detail}</span>}
      </p>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-500">
        <span className="font-mono">
          {fmtEastern(row.at)} · {row.actor}
        </span>
        <button
          type="button"
          onClick={onToggle}
          className="shrink-0 font-medium text-brand-700 hover:underline"
        >
          {open ? "Hide" : "View details"}
        </button>
      </div>
      {open && (
        <pre className="mt-2 max-h-48 overflow-auto rounded bg-slate-900/[0.03] p-2 font-mono text-[11px] leading-snug text-slate-700">
          {pretty || "—"}
        </pre>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok";
}) {
  return (
    <div className="text-right">
      <p
        className={`text-lg font-semibold tabular-nums ${tone === "ok" ? "text-emerald-600" : "text-brand-900"}`}
      >
        {value}
      </p>
      <p className="text-xs text-muted-500">{label}</p>
    </div>
  );
}
