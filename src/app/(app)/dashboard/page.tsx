import { formatBytes, timeAgo } from "@/lib/format";
import { getRailData } from "@/server/rail";

// Dashboard — the storage + activity overview (spec 0004 AC-11). Reuses the
// rail data source so the figures cannot drift from the rail.
export default async function DashboardPage() {
  const data = await getRailData();

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold text-brand-900">Dashboard</h1>
      <p className="mt-1 text-sm text-muted-500">
        An overview of your organization&apos;s storage and recent activity.
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <section className="rounded-[--radius-panel] border border-border bg-surface p-6">
          <h2 className="text-sm font-semibold text-slate-800">Storage</h2>
          {data ? (
            <>
              <p className="mt-3 text-2xl font-semibold text-brand-900">
                {data.usage.pct}%
              </p>
              <div
                className="mt-2 h-2 w-full overflow-hidden rounded-full bg-canvas"
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
              <p className="mt-2 text-sm text-muted-500">
                {formatBytes(data.usage.usedBytes)} of{" "}
                {formatBytes(data.usage.quotaBytes)} used ·{" "}
                {data.history.count} today
              </p>
            </>
          ) : (
            <p className="mt-2 text-sm text-muted-500">No storage data.</p>
          )}
        </section>

        <section className="rounded-[--radius-panel] border border-border bg-surface p-6">
          <h2 className="text-sm font-semibold text-slate-800">
            Recent activity
          </h2>
          {!data || data.activity.length === 0 ? (
            <p className="mt-2 text-sm text-muted-500">Nothing recent.</p>
          ) : (
            <ul className="mt-3 space-y-3">
              {data.activity.map((e) => (
                <li key={e.id} className="text-sm leading-snug">
                  <span className="text-slate-700">{e.summary}</span>
                  <span className="mt-0.5 block text-xs text-muted-500">
                    {e.actorName ? `${e.actorName} · ` : ""}
                    {timeAgo(e.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
