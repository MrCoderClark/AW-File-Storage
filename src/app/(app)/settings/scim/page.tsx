import { notFound } from "next/navigation";
import { ScimSettingsSection } from "@/components/scim-settings-section";
import { isPlatformOwner } from "@/server/platform";

export const dynamic = "force-dynamic";

// SCIM provisioning settings (spec 0015). Platform owner only — a non-owner gets a
// 404 (the /api/scim-config routes re-check independently).
export default async function ScimSettingsPage() {
  if (!(await isPlatformOwner())) notFound();
  return <ScimSettingsSection />;
}
