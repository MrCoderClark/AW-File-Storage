import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type AppSettingsEnv,
  getAppSettings,
  setRequireAppHostCardLogin,
} from "../src/server/app-settings";
import { buildDb } from "../src/server/db";
import { appSettings } from "../src/server/db/schema";

const db = buildDb(env.DB);
const ENV = { DB: env.DB } as unknown as AppSettingsEnv;

beforeEach(async () => {
  await db.delete(appSettings);
});

describe("app settings", () => {
  it("defaults to requiring app-host login when no row exists", async () => {
    const s = await getAppSettings(ENV);
    expect(s.requireAppHostCardLogin).toBe(true);
  });

  it("persists a toggle off and back on (upsert, single row)", async () => {
    await setRequireAppHostCardLogin(ENV, false);
    expect((await getAppSettings(ENV)).requireAppHostCardLogin).toBe(false);

    await setRequireAppHostCardLogin(ENV, true);
    expect((await getAppSettings(ENV)).requireAppHostCardLogin).toBe(true);

    // Never more than one row (id is a fixed key).
    const rows = await db.select().from(appSettings);
    expect(rows).toHaveLength(1);
  });
});
