import { notFound } from "next/navigation";
import { ProvisioningSection } from "@/components/provisioning-section";
import { isPlatformOwner } from "@/server/platform";

export const dynamic = "force-dynamic";

// Provisioning console (spec 0014). Platform owner only — a non-owner gets a 404
// (the API routes re-check independently).
export default async function ProvisioningPage() {
  if (!(await isPlatformOwner())) notFound();
  return <ProvisioningSection />;
}
