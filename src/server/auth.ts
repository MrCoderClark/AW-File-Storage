import { getCloudflareContext } from "@opennextjs/cloudflare";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { buildDb } from "./db";
import * as schema from "./db/schema";
import { authPlugins, authSharedOptions } from "./auth-options";

/** The env values auth needs: the D1 binding plus the auth secrets/URL. */
export interface AuthEnv {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  APP_URL: string;
}

/**
 * The runtime Better Auth instance, built per request from the Worker's env
 * (the D1 binding only exists per request). Nothing else constructs an auth
 * instance. See spec 0001 for the full security rationale.
 */
export function buildAuth(env: AuthEnv) {
  return betterAuth({
    ...authSharedOptions,
    database: drizzleAdapter(buildDb(env.DB), { provider: "sqlite", schema }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.APP_URL,
    trustedOrigins: [env.APP_URL], // the ONLY trusted origin; no wildcards
    plugins: authPlugins,
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
