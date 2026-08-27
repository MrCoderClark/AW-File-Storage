import { defineConfig } from "drizzle-kit";

// Generates SQL migrations into ./migrations from the Drizzle schema.
// The generated files are applied to D1 by `wrangler d1 migrations apply`
// (Drizzle cannot apply migrations to D1 directly). Wrangler reads the .sql
// files; the meta/ folder Drizzle writes alongside them is ignored by wrangler.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/server/db/schema.ts",
  out: "./migrations",
});
