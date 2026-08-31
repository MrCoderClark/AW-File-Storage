import { ProfileSection } from "@/components/profile-section";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function ProfileSettingsPage() {
  const session = await getSession();
  return (
    <ProfileSection
      initialName={session?.user.name ?? ""}
      email={session?.user.email ?? ""}
    />
  );
}
