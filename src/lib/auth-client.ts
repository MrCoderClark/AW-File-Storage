import { organizationClient, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// Browser-side client. baseURL defaults to the current origin, which is what we
// want. Plugins mirror the server so the org/2FA client methods are available.
export const authClient = createAuthClient({
  plugins: [organizationClient(), twoFactorClient()],
});

export const { signIn, signOut, useSession } = authClient;
