// Left rail (spec 0004 AC-1). Panels are structural now; Upload History,
// Storage Usage, and Recent Activity get live data in a later sub-step.

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
  return (
    <aside className="w-60 shrink-0 border-r border-border bg-surface">
      <RailPanel title="Upload History">
        <p>No uploads yet today.</p>
      </RailPanel>
      <RailPanel title="Storage Usage">
        <div className="h-2 w-full overflow-hidden rounded-full bg-canvas">
          <div className="h-full w-0 rounded-full bg-accent-500" />
        </div>
        <p className="mt-1 text-xs">0% used</p>
      </RailPanel>
      <RailPanel title="Recent Activity">
        <p>Nothing recent.</p>
      </RailPanel>
    </aside>
  );
}
