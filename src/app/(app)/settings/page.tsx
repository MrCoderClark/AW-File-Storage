// Settings — profile, password, second factor, and member management (spec 0004
// scope). Sections are wired up in a later sub-step.
export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold text-brand-900">Settings</h1>
      <p className="mt-1 text-sm text-muted-500">
        Manage your profile, password, two-factor authentication, and members.
      </p>
      <div className="mt-6 rounded-[--radius-panel] border border-border bg-surface p-6 text-sm text-muted-500">
        Settings sections are coming soon.
      </div>
    </div>
  );
}
