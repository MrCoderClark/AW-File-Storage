import { eq } from "drizzle-orm";
import { appSettings } from "./db/schema";
import { buildDb } from "./db";

// Site-wide app settings (spec 0009 follow-up): a single row (id = "app").
// Read on the app host to decide whether card pages require a login; written from
// Settings by owners/admins.

export interface AppSettingsEnv {
  DB: D1Database;
}

export interface AppSettings {
  /** When true, /c/* on the app host (www) requires a signed-in session. */
  requireAppHostCardLogin: boolean;
  /** Office 365 CustomAttribute1 sync master switch (also needs GRAPH_* secrets). */
  o365SyncEnabled: boolean;
}

const DEFAULTS: AppSettings = {
  requireAppHostCardLogin: true,
  o365SyncEnabled: false,
};
const ROW_ID = "app";

/**
 * The site settings, falling back to defaults when the row (or, before the
 * migration is applied, the table) does not exist yet. Defaulting to "on" keeps
 * the gate closed if the read ever fails, which is the safe direction.
 */
export async function getAppSettings(env: AppSettingsEnv): Promise<AppSettings> {
  try {
    const db = buildDb(env.DB);
    const [row] = await db
      .select({
        requireAppHostCardLogin: appSettings.requireAppHostCardLogin,
        o365SyncEnabled: appSettings.o365SyncEnabled,
      })
      .from(appSettings)
      .where(eq(appSettings.id, ROW_ID))
      .limit(1);
    return {
      requireAppHostCardLogin:
        row?.requireAppHostCardLogin ?? DEFAULTS.requireAppHostCardLogin,
      o365SyncEnabled: row?.o365SyncEnabled ?? DEFAULTS.o365SyncEnabled,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Turn the Office 365 sync on or off (upsert the single settings row). */
export async function setO365SyncEnabled(
  env: AppSettingsEnv,
  value: boolean,
): Promise<void> {
  const db = buildDb(env.DB);
  await db
    .insert(appSettings)
    .values({ id: ROW_ID, o365SyncEnabled: value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettings.id,
      set: { o365SyncEnabled: value, updatedAt: new Date() },
    });
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
