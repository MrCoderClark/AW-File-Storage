import { InvitationsPanel } from "@/components/invitations-panel";
import { requireOrgRole } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function InvitationsSettingsPage() {
  await requireOrgRole("admin"); // members get a 404 here
  return <InvitationsPanel />;
}
