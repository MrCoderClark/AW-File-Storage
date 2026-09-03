import { eq } from "drizzle-orm";
import { appSettings } from "./db/schema";
import { buildDb } from "./db";

// Platform-level (site-wide) settings: a single row (id = "app"). Kept
// deliberately global — `requireAppHostCardLogin` is a host-level access policy
// checked BEFORE any card is resolved (src/app/c/[slug]/route.ts), so it cannot
// be per-org without leaking which cards exist (spec 0012 decision). Its value is
// changed only by the platform ("app") owner; per-org settings live in
// `org_settings` (org-db.ts `orgDb().settings`), not here.

export interface AppSettingsEnv {
  DB: D1Database;
}

export interface AppSettings {
  /** When true, /c/* on the app host (www) requires a signed-in session. */
  requireAppHostCardLogin: boolean;
}

const DEFAULTS: AppSettings = {
  requireAppHostCardLogin: true,
};
const ROW_ID = "app";

/**
 * The platform settings, falling back to defaults when the row (or, before the
 * migration is applied, the table) does not exist yet. Defaulting to "on" keeps
 * the gate closed if the read ever fails, which is the safe direction.
 */
export async function getAppSettings(env: AppSettingsEnv): Promise<AppSettings> {
  try {
    const db = buildDb(env.DB);
    const [row] = await db
      .select({
        requireAppHostCardLogin: appSettings.requireAppHostCardLogin,
      })
      .from(appSettings)
      .where(eq(appSettings.id, ROW_ID))
      .limit(1);
    return {
      requireAppHostCardLogin:
        row?.requireAppHostCardLogin ?? DEFAULTS.requireAppHostCardLogin,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Set whether the app host requires a login for card pages (upsert the row). */
export async function setRequireAppHostCardLogin(
  env: AppSettingsEnv,
  value: boolean,
): Promise<void> {
  const db = buildDb(env.DB);
  await db
    .insert(appSettings)
    .values({ id: ROW_ID, requireAppHostCardLogin: value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettings.id,
      set: { requireAppHostCardLogin: value, updatedAt: new Date() },
    });
}
