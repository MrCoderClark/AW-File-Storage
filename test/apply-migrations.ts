import { applyD1Migrations, env } from "cloudflare:test";

// Runs once per test worker before the suite: applies the real migrations to
// the isolated test D1 so tests run against the actual schema.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
