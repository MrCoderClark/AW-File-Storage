import { requireSession } from "@/server/session";

// Protected: server-side session check, redirects to /sign-in when absent.
export default async function DashboardPage() {
  const { user, session } = await requireSession();
  const activeOrganizationId =
    (session as { activeOrganizationId?: string | null })
      .activeOrganizationId ?? "none";

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6">
      <div className="rounded-[--radius-panel] border border-border bg-surface p-8 shadow-sm">
        <h1 className="text-2xl font-semibold text-brand-900">Dashboard</h1>
        <p className="mt-2 text-muted-500">
          Signed in as <strong>{user.email}</strong>.
        </p>
        <p className="mt-1 text-sm text-muted-500">
          Active organization: <code>{activeOrganizationId}</code>
        </p>
      </div>
    </main>
  );
}
