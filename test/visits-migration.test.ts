import { describe, expect, it } from "vitest";

// Migration safety for the visitor-events table (spec 0030 AC-10): the migration
// that introduces `card_visit_event` must be ADDITIVE — CREATE TABLE + indexes
// only — and must never rebuild `file` or any existing table, which on D1 would
// cascade-wipe child rows (PROGRESS gotcha #9). Reads the real migration SQL as
// raw text (resolved by Vite at transform time, like the no-db-bypass guard).
const sql = import.meta.glob("/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("card_visit_event migration is additive (spec 0030 AC-10)", () => {
  const owning = Object.entries(sql).filter(([, s]) =>
    s.includes("card_visit_event"),
  );

  it("exists (run `npx drizzle-kit generate` first if this fails)", () => {
    expect(
      owning.length,
      "No migration creates card_visit_event yet — generate it before testing.",
    ).toBeGreaterThan(0);
  });

  it("only CREATEs — it never DROPs or rebuilds an existing table", () => {
    for (const [path, s] of owning) {
      expect(s, `${path} should CREATE the table`).toMatch(
        /create table[^;]*card_visit_event/i,
      );
      expect(s, `${path} must not DROP any table (cascade-wipe risk)`).not.toMatch(
        /drop table/i,
      );
      // No rebuild of an existing table snuck into the same migration.
      expect(s, `${path} must not rebuild the file/organization tables`).not.toMatch(
        /create table `?__new_(file|organization)/i,
      );
    }
  });
});
