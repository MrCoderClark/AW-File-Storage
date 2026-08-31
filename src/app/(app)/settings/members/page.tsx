import { MembersSection } from "@/components/members-section";
import { getActor, requireOrgRole } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function MembersSettingsPage() {
  await requireOrgRole("admin"); // members get a 404 here
  const actor = await getActor();
  return <MembersSection currentUserId={actor?.userId ?? ""} />;
}
