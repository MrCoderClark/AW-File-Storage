const appName = process.env.NEXT_PUBLIC_APP_NAME ?? "AW File Storage";

// Shared chrome for the signed-out pages (sign-in siblings): navy app bar, a
// centred card, and a navy footer. Pure markup, so it renders on the server.
export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 bg-brand-900 px-4 text-white sm:px-6">
        <CloudIcon className="h-7 w-7 text-accent-500" />
        <span className="font-semibold">{appName}</span>
      </header>

      <main className="flex flex-1 items-center bg-canvas px-4 py-10 sm:px-6">
        <div className="mx-auto w-full max-w-md rounded-[--radius-drop] border border-border bg-surface p-6 shadow-sm sm:p-8">
          <h1 className="text-xl font-semibold text-brand-900">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-muted-500">{subtitle}</p>}
          {children}
        </div>
      </main>

      <footer className="flex shrink-0 items-center bg-brand-900 px-4 py-3 text-[11px] text-white/60 sm:px-6">
        <span>
          &copy; {new Date().getFullYear()} America Works. All rights reserved.
        </span>
      </footer>
    </div>
  );
}

function CloudIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M6.5 19a4.5 4.5 0 0 1-.53-8.97 6 6 0 0 1 11.64-1.4A4.25 4.25 0 0 1 17.75 19H6.5Z" />
    </svg>
  );
}
