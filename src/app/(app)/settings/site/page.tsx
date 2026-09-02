import { SiteSettingsSection } from "@/components/site-settings-section";
import { requireOrgRole } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function SiteSettingsPage() {
  await requireOrgRole("admin"); // members get a 404 here
  return <SiteSettingsSection />;
}
