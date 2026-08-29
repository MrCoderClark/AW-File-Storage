import { getCloudflareContext } from "@opennextjs/cloudflare";
import Link from "next/link";
import { AcceptForm } from "@/components/accept-form";
import { Logo } from "@/components/logo";
import { type AuthEnv } from "@/server/auth";
import { previewInvite } from "@/server/invitations";

const appName = process.env.NEXT_PUBLIC_APP_NAME ?? "AW File Storage";

// Reads the per-request invitation state, so it can never be prerendered.
export const dynamic = "force-dynamic";

const ERROR_COPY: Record<string, string> = {
  invalid: "This invitation link is not valid. Ask your administrator to send a new one.",
  expired: "This invitation has expired. Ask your administrator to send a new one.",
  used: "This invitation has already been used. Try signing in instead.",
};

// Public invitation acceptance page (spec 0005 AC-1). Resolves the invitation
// server-side and shows either the acceptance form or a plain message — a
// wrong/expired/used id never reveals the invited email.
export default async function AcceptInvitationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { env } = getCloudflareContext();
  const preview = await previewInvite(env as unknown as AuthEnv, id);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 bg-brand-900 px-4 text-white sm:px-6">
        <Logo className="h-8 w-8" />
        <span className="font-semibold">{appName}</span>
      </header>

      <main className="flex flex-1 items-center bg-canvas px-4 py-10 sm:px-6">
        <div className="mx-auto w-full max-w-md rounded-[--radius-drop] border border-border bg-surface p-6 shadow-sm sm:p-8">
          {preview.status === "valid" ? (
            <>
              <h1 className="text-xl font-semibold text-brand-900">
                Accept your invitation
              </h1>
              <p className="mt-1.5 text-sm text-muted-500">
                Set your name and a password to join {appName}.
              </p>
              <AcceptForm
                invitationId={id}
                email={preview.email}
                role={preview.role}
              />
            </>
          ) : (
            <>
              <h1 className="text-xl font-semibold text-brand-900">
                Invitation unavailable
              </h1>
              <p className="mt-2 text-sm text-muted-500">
                {ERROR_COPY[preview.status]}
              </p>
              <Link
                href="/sign-in"
                className="mt-6 inline-block rounded-[--radius-panel] bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
              >
                Go to sign in
              </Link>
            </>
          )}
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

