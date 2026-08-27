// Dashboard — storage + activity overview (spec 0004). Live figures land with
// the rail data in a later sub-step; the shell already covers auth.
export default function DashboardPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold text-brand-900">Dashboard</h1>
      <p className="mt-1 text-sm text-muted-500">
        An overview of your organization&apos;s storage and recent activity.
      </p>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className="rounded-[--radius-panel] border border-border bg-surface p-6">
          <h2 className="text-sm font-semibold text-slate-800">Storage</h2>
          <p className="mt-2 text-sm text-muted-500">Usage details coming soon.</p>
        </div>
        <div className="rounded-[--radius-panel] border border-border bg-surface p-6">
          <h2 className="text-sm font-semibold text-slate-800">Recent activity</h2>
          <p className="mt-2 text-sm text-muted-500">Nothing recent.</p>
        </div>
      </div>
    </div>
  );
}
