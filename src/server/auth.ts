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
    rateLimit: {
      enabled: true,
      storage: "database", // memory storage does NOT survive across Worker isolates
    },
    plugins: authPlugins,
  });
}

export type Auth = ReturnType<typeof buildAuth>;
