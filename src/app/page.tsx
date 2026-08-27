const appName = process.env.NEXT_PUBLIC_APP_NAME ?? "AW File Storage";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-6 px-6 text-center">
      <div className="rounded-[--radius-panel] border border-border bg-surface px-8 py-10 shadow-sm">
        <p className="text-sm font-medium uppercase tracking-wide text-accent-500">
          Phase 0 · scaffold
        </p>
        <h1 className="mt-2 text-3xl font-semibold text-brand-900">{appName}</h1>
        <p className="mt-4 text-muted-500">
          Next.js on Cloudflare Workers is running. Auth, tenancy, uploads, and
          the Upload Center are built in the phases that follow.
        </p>
      </div>
      <p className="text-xs text-muted-500">
        See <code>docs/specs/0001-secure-file-storage-platform/</code> for the
        specifications.
      </p>
    </main>
  );
}
