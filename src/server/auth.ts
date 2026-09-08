import { getCloudflareContext } from "@opennextjs/cloudflare";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { and, eq, isNull, or } from "drizzle-orm";
import { buildDb } from "./db";
import * as schema from "./db/schema";
import { authPlugins, authSharedOptions } from "./auth-options";
import { linkEmail, sendEmail } from "./email";
import { clearFailures, isLocked, recordFailure } from "./lockout";
import { isSuspendedEverywhere } from "./members";

const GENERIC_SIGNIN_FAILURE = "Email or password is incorrect.";
const SUSPENDED_MESSAGE =
  "Your access has been suspended. Contact your administrator.";

/** The env values auth needs: the D1 binding, the auth secrets/URL, and email. */
export interface AuthEnv {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  APP_URL: string;
  /**
   * Extra exact origins allowed alongside APP_URL, comma separated (e.g. the
   * workers.dev URL while a custom domain is the canonical APP_URL). Exact
   * origins only - never a wildcard.
   */
  TRUSTED_ORIGINS?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
}

/** APP_URL plus any explicitly allowed extra origins. Exact matches, no wildcards. */
function trustedOrigins(env: AuthEnv): string[] {
  const extra = (env.TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter((o) => o.length > 0);
  return [...new Set([env.APP_URL.replace(/\/+$/, ""), ...extra])];
}

/**
 * The runtime Better Auth instance, built per request from the Worker's env
 * (the D1 binding only exists per request). Nothing else constructs an auth
 * instance. See spec 0001 for the full security rationale.
 */
export function buildAuth(env: AuthEnv) {
  const db = buildDb(env.DB);
  const emailCfg = {
    apiKey: env.RESEND_API_KEY,
    from: env.EMAIL_FROM ?? "no-reply@americaworks.com",
  };
  return betterAuth({
    ...authSharedOptions,
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.APP_URL,
    trustedOrigins: trustedOrigins(env), // exact origins only; no wildcards
    // Email-bearing config lives here (buildAuth has env); the non-function
    // email options come from authSharedOptions and are preserved by the spread.
    emailAndPassword: {
      ...authSharedOptions.emailAndPassword,
      sendResetPassword: async ({ user, url }) => {
        await sendEmail(emailCfg, {
          to: user.email,
          subject: "Reset your password",
          html: linkEmail(
            "We received a request to reset your AW File Storage password. Use the button below to choose a new one.",
            url,
            "Reset password",
            user.name,
          ),
        });
      },
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, url }) => {
        await sendEmail(emailCfg, {
          to: user.email,
          subject: "Verify your email",
          html: linkEmail(
            "Please confirm your email address to finish setting up your AW File Storage account.",
            url,
            "Verify email",
            user.name,
          ),
        });
      },
    },
    plugins: authPlugins,
    hooks: {
      // Per-account lockout (AC-7), wrapped around the email sign-in endpoint.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-in/email") return;
        const email = (ctx.body as { email?: string } | undefined)?.email;
        if (!email) return;
        if (await isLocked(db, email)) {
          // Same generic message as a wrong password — never reveal the lock.
          throw new APIError("UNAUTHORIZED", { message: GENERIC_SIGNIN_FAILURE });
        }
        // A member suspended in every org they belong to is refused (AC-7).
        if (await isSuspendedEverywhere({ DB: env.DB }, email)) {
          throw new APIError("FORBIDDEN", { message: SUSPENDED_MESSAGE });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-in/email") return;
        const email = (ctx.body as { email?: string } | undefined)?.email;
        if (!email) return;
        // A thrown endpoint leaves an APIError in `returned`; success leaves the response.
        if (ctx.context.returned instanceof APIError) {
          await recordFailure(db, email);
        } else {
          await clearFailures(db, email);
        }
      }),
    },
    databaseHooks: {
      session: {
        create: {
          // Set the acting organization on the session at creation, so
          // org-scoped queries and requireOrgRole() have an org from the first
          // request. Uses the user's first membership (users here have one org).
          before: async (session) => {
            // Prefer an ACTIVE membership so a suspended one is never made the
            // active org (spec 0005). Legacy rows with a null status count as active.
            const [membership] = await db
              .select({ orgId: schema.member.organizationId })
              .from(schema.member)
              .where(
                and(
                  eq(schema.member.userId, session.userId),
                  or(
                    eq(schema.member.status, "active"),
                    isNull(schema.member.status),
                  ),
                ),
              )
              .limit(1);
            return {
              data: {
                ...session,
                activeOrganizationId: membership?.orgId ?? null,
              },
            };
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof buildAuth>;

/**
 * The Better Auth instance for the current request, built from the Worker's
 * Cloudflare env (D1 binding + secrets from wrangler/.dev.vars). Must be called
 * within request scope.
 */
export function getAuth(): Auth {
  const { env } = getCloudflareContext();
  return buildAuth(env as unknown as AuthEnv);
}
