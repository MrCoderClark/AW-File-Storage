import { redirect } from "next/navigation";
import { AppDataProvider } from "@/components/app-data";
import { AppHeader } from "@/components/app-header";
import { AppNav } from "@/components/app-nav";
import { AppShellBody } from "@/components/app-shell-body";
import { SideRail } from "@/components/side-rail";
import { getRailData } from "@/server/rail";
import { getShellData } from "@/server/shell";

const appName = process.env.NEXT_PUBLIC_APP_NAME ?? "AW File Storage";

// The shell reads the per-request session (cookies + D1), so it can never be
// statically prerendered — force dynamic rendering for every (app) route.
export const dynamic = "force-dynamic";

// The signed-in application shell (spec 0004). Every route under (app) requires
// a session; anonymous callers are redirected to sign in (AC-16).
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const shell = await getShellData();
  if (!shell) redirect("/sign-in");
  const rail = await getRailData();

  return (
    <AppDataProvider initialRail={rail}>
      <div className="flex min-h-screen flex-col">
        <AppHeader
          userName={shell.userName}
          userEmail={shell.userEmail}
          orgName={shell.orgName}
          role={shell.role}
          activeOrgId={shell.activeOrgId}
          orgs={shell.orgs}
        />
        <AppNav />
        <AppShellBody rail={<SideRail />}>{children}</AppShellBody>
        <footer className="flex items-center justify-between border-t border-border bg-surface px-6 py-3 text-xs text-muted-500">
          <span>© {new Date().getFullYear()} {appName}. All rights reserved.</span>
          <span className="flex gap-4">
            <a href="#" className="hover:text-slate-700">Privacy</a>
            <a href="#" className="hover:text-slate-700">Support</a>
          </span>
        </footer>
      </div>
    </AppDataProvider>
  );
}
