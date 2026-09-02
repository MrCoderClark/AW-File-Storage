import { O365SettingsSection } from "@/components/o365-settings-section";
import { requireOrgRole } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function O365SettingsPage() {
  await requireOrgRole("admin"); // members get a 404 here
  return <O365SettingsSection />;
}
