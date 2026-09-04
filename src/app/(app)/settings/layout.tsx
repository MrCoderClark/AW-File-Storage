import { SettingsNav } from "@/components/settings-nav";
import { isPlatformOwner } from "@/server/platform";
import { getActor } from "@/server/session";

// Settings hub layout (side nav + section content). Wraps every /settings/*
// route. Reads the caller's role to decide which nav links to show; each admin
// section page still re-checks the role itself.
export const dynamic = "force-dynamic";

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const actor = await getActor();
  const canManage = actor?.canManageAny ?? false;
  const platformOwner = await isPlatformOwner();

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-col gap-6 lg:flex-row">
        <aside className="lg:w-56 lg:shrink-0">
          <h1 className="mb-3 text-xl font-semibold text-brand-900">Settings</h1>
          <SettingsNav canManage={canManage} isPlatformOwner={platformOwner} />
        </aside>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
