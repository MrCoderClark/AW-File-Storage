import { nextCookies } from "better-auth/next-js";
import { haveIBeenPwned } from "better-auth/plugins/haveibeenpwned";
import { organization } from "better-auth/plugins/organization";
import { twoFactor } from "better-auth/plugins/two-factor";

/**
 * Better Auth options shared by the runtime instance (auth.ts) and the CLI
 * config used for schema generation (better-auth.config.ts). This file must not
 * import the D1 client or any Cloudflare-only module, so the CLI can load it in
 * plain Node.
 *
 * Every value here is a deliberate security choice from spec 0001. See the
 * "What Better Auth gives us, and what we add" table in that spec.
 */

// Plugins. `nextCookies()` MUST be last so Next.js server actions can set the
// session cookie. `organization` owns organizations/members/invitations (the
// tenancy tables spec 0002 builds on); `twoFactor` owns TOTP + backup codes.
export const authPlugins = [
  organization({
    // Storage accounting lives on the organization row (spec 0002). These are
    // server-managed (input: false), so no client can set them.
    schema: {
      organization: {
        additionalFields: {
          storageQuotaBytes: {
            type: "number",
            defaultValue: 5497558138880, // 5 TB placeholder (spec 0002)
            input: false,
          },
          storageUsedBytes: { type: "number", defaultValue: 0, input: false },
          publicDomain: {
            type: "string",
            defaultValue: "contacts.americaworks.com",
            input: false,
          },
        },
      },
    },
  }),
  twoFactor({ issuer: "AW File Storage" }),
  // Reject known-breached passwords (spec 0001 AC-14). Checks the HIBP range API
  // with a k-anonymity prefix, so the password never leaves the Worker in full.
  haveIBeenPwned({
    customPasswordCompromisedMessage:
      "This password has appeared in a data breach. Please choose another.",
  }),
  nextCookies(), // MUST remain last
];

export const authSharedOptions = {
  appName: "AW File Storage",
  emailAndPassword: {
    enabled: true,
    disableSignUp: true, // internal only; accounts come from invitations
    minPasswordLength: 12, // spec 0001 AC-14 (Better Auth default is 8)
    maxPasswordLength: 256,
    requireEmailVerification: true, // also turns on enumeration protection
    revokeSessionsOnPasswordReset: true, // AC-6
  },
  session: {
    expiresIn: 60 * 60 * 8, // 8h rolling idle ceiling (AC-5)
    updateAge: 60 * 15, // refresh at most every 15 min
    cookieCache: { enabled: false }, // no signed-cookie cache: revocation stays near-instant
  },
  rateLimit: {
    enabled: true,
    storage: "database", // memory storage does NOT survive across Worker isolates
  },
} as const;
