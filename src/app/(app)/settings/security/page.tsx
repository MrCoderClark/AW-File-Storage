import { TwoFactorSection } from "@/components/two-factor-section";
import { activeMembershipTwoFactorRequired, getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function SecuritySettingsPage() {
  const session = await getSession();
  const required = await activeMembershipTwoFactorRequired();
  return (
    <TwoFactorSection
      enrolled={Boolean(
        (session?.user as { twoFactorEnabled?: boolean } | undefined)
          ?.twoFactorEnabled,
      )}
      required={required}
    />
  );
}
