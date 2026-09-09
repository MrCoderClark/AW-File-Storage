import { redirect } from "next/navigation";
import { KbShell } from "@/components/kb/kb-shell";
import { requireOrgRole } from "@/server/session";
import { getShellData } from "@/server/shell";

// The Knowledge base admin area (spec 0025), outside the app's top-nav shell so it has its own
// CMS chrome. Admin/owner only — requireOrgRole("admin") 404s a member.
export const dynamic = "force-dynamic";

export default async function KbLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireOrgRole("admin");
  const shell = await getShellData();
  if (!shell) redirect("/sign-in");
  return (
    <KbShell
      userName={shell.userName}
      userEmail={shell.userEmail}
      orgName={shell.orgName}
    >
      {children}
    </KbShell>
  );
}
