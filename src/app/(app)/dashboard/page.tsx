import { AreaChart, DonutChart } from "@/components/charts";
import { formatBytes, timeAgo } from "@/lib/format";
import { getDashboardData } from "@/server/dashboard";

// Dashboard — storage + activity overview (spec 0004 AC-11), styled to
// docs/Designs/mock-dashboard.jpg. Every figure is real org data.
export default async function DashboardPage() {
  const data = await getDashboardData();

  if (!data) {
    return (
      <div className="mx-auto max-w-6xl">
        <h1 className="text-2xl font-semibold text-brand-900">Dashboard</h1>
        <p className="mt-2 text-sm text-muted-500">No data to show yet.</p>
      </div>
    );
  }

  const segments = [
    { label: "Published cards", value: data.distribution.publishedVcards, color: "#2f86d6" },
    { label: "Private cards", value: data.distribution.privateVcards, color: "#14385c" },
    { label: "Other files", value: data.distribution.other, color: "#94a3b8" },
  ];

  // Dense 30-day engagement trend (the series only carries active days, so fill
  // the gaps for a gapless chart), matching the uploads chart's shape.
  const eng = data.engagement;
  const engByDate = new Map(
    eng.series.map((p) => [p.date, p.views + p.scans + p.downloads]),
  );
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const engTrend: number[] = [];
  for (let i = 29; i >= 0; i--) {
    const day = new Date(todayUtc - i * 86400000).toISOString().slice(0, 10);
    engTrend.push(engByDate.get(day) ?? 0);
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-brand-900">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-500">
          An overview of your organization&apos;s storage and activity.
        </p>
      </div>

      {/* Stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Team Members" value={String(data.memberCount)}>
          <UsersIcon className="h-8 w-8 text-accent-500/80" />
        </StatCard>

        <StatCard
          label="Storage Used"
          value={`${formatBytes(data.usage.usedBytes)}`}
          sub={`of ${formatBytes(data.usage.quotaBytes)} · ${
            // A real but tiny usage rounds to 0% — show "<1%" so it doesn't read
            // as "nothing used".
            data.usage.pct === 0 && data.usage.usedBytes > 0
              ? "<1%"
              : `${data.usage.pct}%`
          }`}
        >
          <div className="w-24">
            <div className="h-2 w-full overflow-hidden rounded-full bg-canvas">
              <div
                className="h-full rounded-full bg-accent-500"
                style={{ width: `${Math.min(100, data.usage.pct)}%` }}
              />
            </div>
          </div>
        </StatCard>

        <StatCard
          label="Published Cards"
          value={String(data.totals.published)}
          sub={`${data.totals.files} files total`}
        >
          <LinkIcon className="h-8 w-8 text-emerald-500/80" />
        </StatCard>
      </div>

      {/* Charts */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Uploads (Last 30 Days)" className="lg:col-span-2">
          <p className="text-2xl font-semibold text-brand-900">
            {data.uploadsByDay.reduce((s, d) => s + d.count, 0)}
            <span className="ml-2 text-sm font-normal text-muted-500">
              in the last 30 days
            </span>
          </p>
          <div className="mt-4">
            <AreaChart
              values={data.uploadsByDay.map((d) => d.count)}
              ariaLabel="Uploads per day over the last 30 days"
            />
          </div>
        </Panel>

        <Panel title="File Types">
          <div className="mt-2">
            <DonutChart segments={segments} />
          </div>
        </Panel>
      </div>

      {/* Card engagement (spec 0008) */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Card Engagement (Last 30 Days)" className="lg:col-span-2">
          <div className="flex flex-wrap gap-8">
            <Metric label="Views" value={eng.totals.views} />
            <Metric label="Scans" value={eng.totals.scans} />
            <Metric label="Downloads" value={eng.totals.downloads} />
          </div>
          <div className="mt-4">
            <AreaChart
              values={engTrend}
              ariaLabel="Card views, scans, and downloads per day over the last 30 days"
            />
          </div>
        </Panel>

        <Panel title="Top Cards">
          {eng.topCards.length === 0 ? (
            <p className="text-sm text-muted-500">No card activity yet.</p>
          ) : (
            <ul className="space-y-2.5">
              {eng.topCards.map((c) => (
                <li
                  key={c.fileId}
                  className="flex items-center gap-3 text-sm"
                  title={`${c.views} views · ${c.scans} scans · ${c.downloads} downloads`}
                >
                  <span className="min-w-0 flex-1 truncate text-slate-700">
                    {c.name}
                  </span>
                  <span className="shrink-0 tabular-nums font-medium text-brand-900">
                    {c.views + c.scans + c.downloads}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {/* Recent activity */}
      <Panel title="Recent Activity">
        {data.activity.length === 0 ? (
          <p className="text-sm text-muted-500">Nothing recent.</p>
        ) : (
          <ul className="divide-y divide-border">
            {data.activity.map((e) => (
              <li key={e.id} className="flex items-center gap-3 py-2.5">
                <Avatar name={e.actorName} />
                <span className="min-w-0 flex-1 truncate text-sm text-slate-700">
                  {e.summary}
                  {e.actorName && (
                    <span className="text-muted-500"> · {e.actorName}</span>
                  )}
                </span>
                <span className="shrink-0 text-xs text-muted-500">
                  {timeAgo(e.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  children,
}: {
  label: string;
  value: string;
  sub?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-[--radius-panel] border border-border bg-surface p-5">
      <div className="min-w-0">
        <p className="text-sm text-muted-500">{label}</p>
        <p className="mt-1 truncate text-2xl font-semibold text-brand-900">
          {value}
        </p>
        {sub && <p className="mt-0.5 text-xs text-muted-500">{sub}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-2xl font-semibold tabular-nums text-brand-900">
        {value.toLocaleString()}
      </p>
      <p className="mt-0.5 text-xs text-muted-500">{label}</p>
    </div>
  );
}

function Panel({
  title,
  className = "",
  children,
}: {
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`rounded-[--radius-panel] border border-border bg-surface p-5 ${className}`}
    >
      <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Avatar({ name }: { name: string }) {
  const initials = name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-600/10 text-xs font-semibold text-brand-600">
      {initials || "•"}
    </span>
  );
}

function UsersIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" strokeLinecap="round" />
      <path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M17 19a5.5 5.5 0 0 0-2.3-4.5" strokeLinecap="round" />
    </svg>
  );
}
function LinkIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M10 13.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 0 0-5-5L11 7.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 10.5a3.5 3.5 0 0 0-5 0L6.5 13a3.5 3.5 0 0 0 5 5L13 16.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
