import { getCloudflareContext } from "@opennextjs/cloudflare";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { eq } from "drizzle-orm";
import { buildDb } from "./db";
import * as schema from "./db/schema";
import { authPlugins, authSharedOptions } from "./auth-options";
import { linkEmail, sendEmail } from "./email";
import { clearFailures, isLocked, recordFailure } from "./lockout";

const GENERIC_SIGNIN_FAILURE = "Email or password is incorrect.";

/** The env values auth needs: the D1 binding, the auth secrets/URL, and email. */
export interface AuthEnv {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  APP_URL: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
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
    trustedOrigins: [env.APP_URL], // the ONLY trusted origin; no wildcards
    // Email-bearing config lives here (buildAuth has env); the non-function
    // email options come from authSharedOptions and are preserved by the spread.
    emailAndPassword: {
      ...authSharedOptions.emailAndPassword,
      sendResetPassword: async ({ user, url }) => {
        await sendEmail(emailCfg, {
          to: user.email,
          subject: "Reset your password",
          html: linkEmail("Reset your password:", url, "Reset password"),
        });
      },
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, url }) => {
        await sendEmail(emailCfg, {
          to: user.email,
          subject: "Verify your email",
          html: linkEmail("Confirm your email address:", url, "Verify email"),
        });
      },
    },
    plugins: authPlugins,
    hooks: {
      // Per-account lockout (AC-7), wrapped around the email sign-in endpoint.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-in/email") return;
        const email = (ctx.body as { email?: string } | undefined)?.email;
        if (email && (await isLocked(db, email))) {
          // Same generic message as a wrong password — never reveal the lock.
          throw new APIError("UNAUTHORIZED", { message: GENERIC_SIGNIN_FAILURE });
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
            const [membership] = await db
              .select({ orgId: schema.member.organizationId })
              .from(schema.member)
              .where(eq(schema.member.userId, session.userId))
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
