import { OrganizationSection } from "@/components/organization-section";
import { requireOrgRole } from "@/server/session";

export const dynamic = "force-dynamic";

// Organization settings (spec 0012): identity + storage, rename (owner), the
// danger-zone delete (owner), and create-organization (platform owner). Admins
// and owners reach this page; members get a 404. The section re-checks each
// capability against the server (GET /api/organization) before showing it.
export default async function OrganizationSettingsPage() {
  await requireOrgRole("admin"); // members get a 404 here
  return <OrganizationSection />;
}
