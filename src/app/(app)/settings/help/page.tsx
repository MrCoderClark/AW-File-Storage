import { HelpAdminSection } from "@/components/help-admin";
import { requireOrgRole } from "@/server/session";

// The help-article editor (spec 0024, slice 2b). Owner/admin only; the platform owner also
// gets the "share to all orgs" control (the section reads `canShare` from the API).
export const dynamic = "force-dynamic";

export default async function HelpSettingsPage() {
  await requireOrgRole("admin"); // members get a 404 here
  return <HelpAdminSection />;
}
