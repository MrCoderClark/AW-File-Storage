import { RegionalSocialLinksSection } from "@/components/regional-social-links-section";
import { requireOrgRole } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function SocialLinksSettingsPage() {
  await requireOrgRole("admin"); // members get a 404 here
  return <RegionalSocialLinksSection />;
}
