import { InvitationsPanel } from "@/components/invitations-panel";
import { MembersSection } from "@/components/members-section";
import { ProfileSection } from "@/components/profile-section";
import { RegionalSocialLinksSection } from "@/components/regional-social-links-section";
import { TwoFactorSection } from "@/components/two-factor-section";
import {
  activeMembershipTwoFactorRequired,
  getActor,
  getSession,
} from "@/server/session";

// Reads the caller's role + identity per request.
export const dynamic = "force-dynamic";

// Settings — everyone can edit their own profile; owner/admin also manage the
// organization's members and invitations (spec 0005). The API re-checks the role.
export default async function SettingsPage() {
  const session = await getSession();
  const actor = await getActor();
  const canManage = actor?.canManageAny ?? false;
  const twoFactorRequired = await activeMembershipTwoFactorRequired();

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-semibold text-brand-900">Settings</h1>
      <p className="mt-1 text-sm text-muted-500">
        {canManage
          ? "Manage your profile and the people in your organization."
          : "Manage your profile."}
      </p>

      <div className="mt-6 space-y-6">
        <ProfileSection
          initialName={session?.user.name ?? ""}
          email={session?.user.email ?? ""}
        />

        <TwoFactorSection
          enrolled={Boolean(
            (session?.user as { twoFactorEnabled?: boolean } | undefined)
              ?.twoFactorEnabled,
          )}
          required={twoFactorRequired}
        />

        {canManage && (
          <div className="space-y-6">
            <MembersSection currentUserId={actor?.userId ?? ""} />
            <InvitationsPanel />
            <RegionalSocialLinksSection />
          </div>
        )}
      </div>
    </div>
  );
}
