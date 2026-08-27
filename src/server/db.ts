import { getCloudflareContext } from "@opennextjs/cloudflare";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/schema";

/** Build a Drizzle client from a D1 binding. One client per request. */
export function buildDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type Db = ReturnType<typeof buildDb>;

/**
 * The unscoped Drizzle client for the current request, from the Cloudflare
 * `DB` binding.
 *
 * Only Better Auth (through its adapter) and the `repos/` and `auth/` modules
 * may call this. Feature code must reach tenant data through the org-scoped
 * wrapper in org-db.ts, so that a query cannot silently skip its organization
 * filter. A lint/test guard asserts nothing else imports this module.
 */
export function getDb(): Db {
  const { env } = getCloudflareContext();
  return buildDb(env.DB);
}
