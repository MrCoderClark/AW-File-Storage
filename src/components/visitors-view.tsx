"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Per-visitor engagement feed (spec 0030), the Analytics tab under Activity Logs.
// Owner/admin only (the page gates it and the API re-checks). Shows who engaged
// with the org's cards — location, network, device, referrer, time — plus an
// approximate unique-visitor count for the current filter.

type Metric = "view" | "scan" | "download" | "pdf";

interface VRow {
  id: string;
  at: number;
  metric: Metric;
  fileId: string;
  card: string;
  slug: string | null;
  ip: string | null;
  location: string;
  timezone: string | null;
  network: string;
  device: string;
  userAgent: string | null;
  referrer: string | null;
  src: string | null;
}
interface CardOpt {
  fileId: string;
  name: string;
  slug: string | null;
}

const RANGES = [
  { v: "1", l: "Last 24 hours" },
  { v: "7", l: "Last 7 days" },
  { v: "30", l: "Last 30 days" },
  { v: "all", l: "All time" },
];

const METRIC_CHIPS: { v: string; l: string }[] = [
  { v: "", l: "All activity" },
  { v: "view", l: "Views" },
  { v: "scan", l: "Scans" },
  { v: "download", l: "Downloads" },
  { v: "pdf", l: "PDF saves" },
];

// Literal class strings (Tailwind JIT needs them whole) per metric.
const METRIC_BADGE: Record<Metric, string> = {
  view: "bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-600/20",
  scan: "bg-indigo-50 text-indigo-700 ring-1 ring-inset ring-indigo-600/20",
  download: "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-600/20",
  pdf: "bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-600/30",
};
const METRIC_LABEL: Record<Metric, string> = {
  view: "View",
  scan: "Scan",
  download: "Download",
  pdf: "PDF save",
};

// New York Eastern time, formatted MM-DD-YYYY h:mmAM/PM — matches Activity Logs.
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

/** A referrer shown as just its host, with the full URL kept for the expander. */
function referrerHost(ref: string | null): string {
  if (!ref) return "Direct";
  try {
    return new URL(ref).host || ref;
  } catch {
    return ref;
  }
}

export function VisitorsView() {
  const [rows, setRows] = useState<VRow[]>([]);
  const [unique, setUnique] = useState<number | null>(null);
  const [cards, setCards] = useState<CardOpt[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [range, setRange] = useState("30");
  const [metric, setMetric] = useState("");
  const [fileId, setFileId] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const reqId = useRef(0);

  const load = useCallback(
    async (cursor: string | null) => {
      const mine = ++reqId.current;
      if (cursor) setLoadingMore(true);
      else setLoading(true);
      setError("");
      try {
        const p = new URLSearchParams({ range });
        if (metric) p.set("metric", metric);
        if (fileId) p.set("fileId", fileId);
        if (cursor) p.set("cursor", cursor);
        const res = await fetch(`/api/analytics/visitors?${p.toString()}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as {
          rows: VRow[];
          nextCursor: string | null;
          uniqueVisitors?: number;
          cards?: CardOpt[];
        };
        if (mine !== reqId.current) return; // a newer request superseded this one
        setRows((prev) => (cursor ? [...prev, ...body.rows] : body.rows));
        setNextCursor(body.nextCursor);
        if (typeof body.uniqueVisitors === "number") setUnique(body.uniqueVisitors);
        if (body.cards) setCards(body.cards);
      } catch {
        if (mine === reqId.current) setError("Could not load visitor analytics.");
      } finally {
        if (mine === reqId.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [range, metric, fileId],
  );

  // Reload from the top whenever a filter changes.
  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-brand-900">
            Visitor analytics
          </h2>
          <p className="mt-1 text-sm text-muted-500">
            Who engaged with your cards — location, network, device, and referrer.
            Visitor detail is kept for 12 months, then removed.
          </p>
        </div>
        <div className="flex gap-5">
          <Stat
            label="Unique visitors"
            value={unique === null ? "—" : unique.toLocaleString()}
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
            {METRIC_CHIPS.map((c) => {
              const active = metric === c.v;
              return (
                <button
                  key={c.v}
                  type="button"
                  onClick={() => setMetric(c.v)}
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
          <select
            value={fileId}
            onChange={(e) => setFileId(e.target.value)}
            className="ml-auto max-w-[16rem] rounded-md border border-border bg-canvas px-2.5 py-1.5 text-sm text-slate-700"
          >
            <option value="">All cards</option>
            {cards.map((c) => (
              <option key={c.fileId} value={c.fileId}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        {/* Content: a shared loading/empty state, then a table (md+) or stacked
            cards (below md), so nothing ever clips or needs horizontal scrolling. */}
        {loading ? (
          <div className="px-4 py-12 text-center text-sm text-muted-500">
            Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-muted-500">
            {error || "No visitors recorded for these filters yet."}
          </div>
        ) : (
          <>
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full min-w-[860px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border bg-canvas/60 text-left text-xs font-semibold uppercase tracking-wide text-muted-500">
                    <th className="px-4 py-2.5 font-semibold">Time (ET)</th>
                    <th className="px-4 py-2.5 font-semibold">Card</th>
                    <th className="px-4 py-2.5 font-semibold">Activity</th>
                    <th className="px-4 py-2.5 font-semibold">Location</th>
                    <th className="px-4 py-2.5 font-semibold">Network</th>
                    <th className="px-4 py-2.5 font-semibold">Device</th>
                    <th className="px-4 py-2.5 font-semibold">IP</th>
                    <th className="px-4 py-2.5 font-semibold" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <VisitRowItem
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

            <div className="divide-y divide-border/70 lg:hidden">
              {rows.map((r) => (
                <VisitCard
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

function MetricBadge({ metric }: { metric: Metric }) {
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${METRIC_BADGE[metric]}`}
    >
      {METRIC_LABEL[metric]}
    </span>
  );
}

function VisitRowItem({
  row,
  open,
  onToggle,
}: {
  row: VRow;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="border-b border-border/70 last:border-0 hover:bg-canvas/50">
        <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-slate-500">
          {fmtEastern(row.at)}
        </td>
        <td className="px-4 py-3 text-slate-800 [overflow-wrap:anywhere]">
          {row.card}
        </td>
        <td className="px-4 py-3">
          <MetricBadge metric={row.metric} />
        </td>
        <td className="px-4 py-3 text-slate-700 [overflow-wrap:anywhere]">
          {row.location || "—"}
        </td>
        <td className="px-4 py-3 text-slate-700 [overflow-wrap:anywhere]">
          {row.network || "—"}
        </td>
        <td className="whitespace-nowrap px-4 py-3 text-slate-700">
          {row.device}
        </td>
        <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-slate-600">
          {row.ip || "—"}
        </td>
        <td className="px-4 py-3 text-right">
          <button
            type="button"
            onClick={onToggle}
            className="text-xs font-medium text-brand-700 hover:underline"
          >
            {open ? "Hide" : "Details"}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-border/70 bg-canvas/40">
          <td colSpan={8} className="px-4 py-3">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs text-slate-600">
              <Detail label="Referrer" value={row.referrer || "Direct"} />
              <Detail label="Source" value={row.src || "—"} />
              <Detail label="Timezone" value={row.timezone || "—"} />
              <Detail label="User agent" value={row.userAgent || "—"} mono />
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}

function Detail({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <>
      <dt className="text-muted-500">{label}</dt>
      <dd
        className={`text-slate-700 [overflow-wrap:anywhere] ${mono ? "font-mono text-[11px]" : ""}`}
      >
        {value}
      </dd>
    </>
  );
}

// Stacked card for one visit on small screens (below lg), where an 8-column table
// would clip or need horizontal scrolling.
function VisitCard({
  row,
  open,
  onToggle,
}: {
  row: VRow;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <MetricBadge metric={row.metric} />
        <span className="font-mono text-xs text-muted-500">
          {fmtEastern(row.at)}
        </span>
      </div>
      <p className="mt-2 text-sm font-medium text-slate-800 [overflow-wrap:anywhere]">
        {row.card}
      </p>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-500">
        {row.location && <span>{row.location}</span>}
        {row.network && <span>· {row.network}</span>}
        <span>· {row.device}</span>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-500">
        <span className="font-mono">{row.ip || "—"}</span>
        <button
          type="button"
          onClick={onToggle}
          className="shrink-0 font-medium text-brand-700 hover:underline"
        >
          {open ? "Hide" : "Details"}
        </button>
      </div>
      {open && (
        <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs text-slate-600">
          <Detail label="Referrer" value={referrerHost(row.referrer)} />
          <Detail label="Source" value={row.src || "—"} />
          <Detail label="Timezone" value={row.timezone || "—"} />
          <Detail label="User agent" value={row.userAgent || "—"} mono />
        </dl>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-right">
      <p className="text-lg font-semibold tabular-nums text-brand-900">{value}</p>
      <p className="text-xs text-muted-500">{label}</p>
    </div>
  );
}
