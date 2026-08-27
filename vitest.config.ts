import { fileURLToPath } from "node:url";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Absolute path to ./migrations, correct on Windows and POSIX.
const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));

// vitest-pool-workers v0.22+ (for vitest 4) is a vite plugin: the worker/
// miniflare config that used to live under test.poolOptions.workers is now
// passed to cloudflareTest(). Read the real migrations so the test D1 has the
// actual schema.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(migrationsDir);

  return {
    plugins: [
      cloudflareTest({
        miniflare: {
          compatibilityDate: "2026-08-01",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          // Handed to the setup file, which applies them to the test DB.
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
