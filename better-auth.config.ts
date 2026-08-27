import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { authPlugins, authSharedOptions } from "./src/server/auth-options";

/**
 * CLI-only config for `@better-auth/cli generate`, which reads the table shapes
 * from the configured plugins to emit the Drizzle schema. It is never imported
 * at runtime. `generate` does not query the database, so the adapter's db is a
 * stub; the real client is wired in src/server/auth.ts.
 */
export const auth = betterAuth({
  ...authSharedOptions,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  database: drizzleAdapter({} as any, { provider: "sqlite" }),
  secret: "cli-only-not-used-at-runtime",
  baseURL: "http://localhost:3000",
  plugins: authPlugins,
});
