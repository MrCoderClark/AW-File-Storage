import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getSession } from "./session";

/**
 * The platform ("app") owner tier (spec 0012). This is above any organization
 * role: it gates the one genuinely platform-level action — creating an
 * organization — and the platform-level `requireAppHostCardLogin` toggle. It is
 * identified by a comma-separated `PLATFORM_OWNER_EMAILS` Worker var, matched
 * case-insensitively against the caller's VERIFIED email, mirroring the existing
 * `TRUSTED_ORIGINS` env-list pattern. No schema, trivial to audit.
 */

export interface PlatformEnv {
  PLATFORM_OWNER_EMAILS?: string;
}

/** The configured platform-owner emails, lower-cased. Empty when unset. */
export function platformOwnerEmails(env: PlatformEnv): Set<string> {
  return new Set(
    (env.PLATFORM_OWNER_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Whether an email is a configured platform owner (case-insensitive). */
export function isPlatformOwnerEmail(env: PlatformEnv, email?: string | null): boolean {
  if (!email) return false;
  return platformOwnerEmails(env).has(email.trim().toLowerCase());
}

/**
 * Whether the current session's user is a platform owner. Requires a verified
 * email so an unverified sign-up can never match. Returns false with no session.
 */
export async function isPlatformOwner(): Promise<boolean> {
  const session = await getSession();
  if (!session) return false;
  const verified = Boolean(
    (session.user as { emailVerified?: boolean }).emailVerified,
  );
  if (!verified) return false;
  const { env } = getCloudflareContext();
  return isPlatformOwnerEmail(env as unknown as PlatformEnv, session.user.email);
}
