"use client";

// Left rail (spec 0004 AC-1, AC-10, AC-11): Upload History, Storage Usage, and
// Recent Activity, rendered from live org data. Seeded with server data on first
// paint, then re-fetched whenever the shared refresh signal bumps (e.g. after an
// upload settles) so Storage Usage updates without a page reload.

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppData } from "@/components/app-data";
import { formatBytes, timeAgo } from "@/lib/format";
import type { RailData } from "@/server/rail";

function RailPanel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-border px-5 py-4">
      <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
      <div className="mt-2 text-sm text-muted-500">{children}</div>
    </section>
  );
}

export function SideRail() {
  const { version, initialRail } = useAppData();
  const [data, setData] = useState<RailData | null>(initialRail);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(initialRail === null);
  // The initial paint already has server data; only refetch on later refreshes.
  const seeded = useRef(initialRail !== null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch("/api/rail", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as RailData;
      setData(body);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!seeded.current) {
      // No server data (or a manual retry) — fetch on mount.
      void load();
      seeded.current = true;
      return;
    }
    if (version > 0) void load();
  }, [version, load]);

  return (
    <aside className="w-60 shrink-0 border-r border-border bg-surface">
      {error ? (
        <RailPanel title="Rail">
          <p>Couldn&apos;t load rail data.</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-2 rounded-[--radius-panel] border border-border px-3 py-1 text-xs font-medium hover:bg-canvas"
          >
            Retry
          </button>
        </RailPanel>
      ) : (
        <>
          <UploadHistoryPanel data={data} loading={loading && !data} />
          <StorageUsagePanel data={data} loading={loading && !data} />
          <RecentActivityPanel data={data} loading={loading && !data} />
        </>
      )}
    </aside>
  );
}

function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-canvas ${className}`} />;
}

function UploadHistoryPanel({
  data,
  loading,
}: {
  data: RailData | null;
  loading: boolean;
}) {
  return (
    <RailPanel title="Upload History">
      {loading || !data ? (
        <Skeleton className="h-4 w-32" />
      ) : data.history.count === 0 ? (
        <p>No uploads yet today.</p>
      ) : (
        <p>
          <span className="font-medium text-slate-800">
            {data.history.count}
          </span>{" "}
          {data.history.count === 1 ? "file" : "files"} today ·{" "}
          {formatBytes(data.history.bytes)}
        </p>
      )}
    </RailPanel>
  );
}

function StorageUsagePanel({
  data,
  loading,
}: {
  data: RailData | null;
  loading: boolean;
}) {
  return (
    <RailPanel title="Storage Usage">
      {loading || !data ? (
        <>
          <Skeleton className="h-2 w-full" />
          <Skeleton className="mt-2 h-3 w-24" />
        </>
      ) : (
        <>
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-canvas"
            role="progressbar"
            aria-valuenow={data.usage.pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Storage used"
          >
            <div
              className="h-full rounded-full bg-accent-500"
              style={{ width: `${Math.min(100, data.usage.pct)}%` }}
            />
          </div>
          <p className="mt-1 text-xs">
            {data.usage.pct}% used · {formatBytes(data.usage.usedBytes)} of{" "}
            {formatBytes(data.usage.quotaBytes)}
          </p>
        </>
      )}
    </RailPanel>
  );
}

function RecentActivityPanel({
  data,
  loading,
}: {
  data: RailData | null;
  loading: boolean;
}) {
  return (
    <RailPanel title="Recent Activity">
      {loading || !data ? (
        <div className="space-y-2">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
          <Skeleton className="h-3 w-3/5" />
        </div>
      ) : data.activity.length === 0 ? (
        <p>Nothing recent.</p>
      ) : (
        <ul className="space-y-2.5">
          {data.activity.map((e) => (
            <li key={e.id} className="text-xs leading-snug">
              <span className="text-slate-700">{e.summary}</span>
              <span className="mt-0.5 block text-muted-500">
                {e.actorName ? `${e.actorName} · ` : ""}
                {timeAgo(e.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </RailPanel>
  );
}
