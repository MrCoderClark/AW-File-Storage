import { MembersSection } from "@/components/members-section";
import { getActor, requireOrgRole } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function MembersSettingsPage() {
  const { role } = await requireOrgRole("admin"); // members get a 404 here
  const actor = await getActor();
  // The caller's role gates the owner-tier controls in the UI (spec 0021); the
  // server re-checks every change, so this is only to avoid offering a control
  // the API would refuse.
  return (
    <MembersSection currentUserId={actor?.userId ?? ""} currentUserRole={role} />
  );
}
