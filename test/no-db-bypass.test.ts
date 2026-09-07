import { describe, expect, it } from "vitest";

// Import every source file as raw text. `import.meta.glob` is resolved by Vite at
// transform time, so this works in the workerd test pool with no filesystem
// access — the files arrive as plain strings, never executed.
const sources = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// Matches an import of the raw D1 CLIENT module `src/server/db.ts` — specifiers
// that END in `/db` (`./db`, `../db`, `@/server/db`) — but NOT `./db/schema`,
// which is the table definitions and is safe to import anywhere.
const DB_CLIENT_IMPORT = /from\s+["'][^"']*\/db["']/;

// The ONLY modules allowed to import the raw client. Everything else must reach
// tenant data through `orgDb` (org-db.ts) so an org filter cannot be forgotten
// (spec 0002 AC-2 / spec 0012 AC-3). This list pins the current reality so no NEW
// silent bypass creeps in; each entry states WHY it is allowed. To fold one of
// the "manually org-scoped" entries through orgDb later, remove it from here.
const ALLOWLIST = new Set<string>([
  // The scoped wrapper itself — the one sanctioned door to tenant data.
  "/src/server/org-db.ts",
  // Better Auth's Drizzle adapter manages the identity tables.
  "/src/server/auth.ts",
  // Identity-only reads (session / member / organization) — never tenant tables.
  "/src/server/session.ts",
  "/src/server/shell.ts",
  // Platform-level, non-tenant tables.
  "/src/server/app-settings.ts", // app_settings (single global row)
  "/src/server/lockout.ts", // account_lock (keyed by user)
  // Cross-org SYSTEM jobs: they must span every org by design, so they cannot be
  // org-scoped — routing them through orgDb would be wrong.
  "/src/server/cleanup.ts", // nightly abandoned-upload sweep across all orgs
  "/src/server/o365-sync.ts", // nightly O365 reconcile across all orgs (uses orgDb for audit/settings)
  "/src/server/o365-provision.ts", // spec 0016: auto-provision cards from the O365 directory across all opted-in orgs (each write confined to the swept org)
  // Run with no active org in scope.
  "/src/app/api/admin/bootstrap/route.ts", // first-user bootstrap
  "/src/app/api/dev/seed/route.ts", // local dev seed
  // Org lifecycle (spec 0012): creates the organization + owner membership
  // (identity tables, platform-owner gated) and deletes the org row (cascade).
  // Uses orgDbFor for the tenant-object sweep; buildDb only for the identity rows.
  "/src/app/api/organization/route.ts",
  // Manually org-scoped tenant access (thread orgId by hand). TODO(spec 0012
  // follow-up): fold these through orgDb the way card-stats/social-links were.
  "/src/server/uploads.ts",
  "/src/server/members.ts",
  "/src/server/dashboard.ts",
  "/src/server/signature.ts",
  "/src/server/rail.ts",
  "/src/server/invitations.ts",
  // Platform-owner provisioning (spec 0014): cross-org by design — the domain map
  // resolves any email to its org, and provisioning writes memberships across orgs.
  // Gated by isPlatformOwner at the route; not org-scopable.
  "/src/server/domains.ts",
  "/src/server/provisioning.ts",
]);

function importsRawDb(path: string, src: string): boolean {
  if (path.endsWith("/db.ts")) return false; // the client module itself
  return DB_CLIENT_IMPORT.test(src);
}

describe("no raw-db bypass (spec 0002 AC-2 / spec 0012 AC-3)", () => {
  it("only allowlisted modules import the raw D1 client", () => {
    const offenders = Object.entries(sources)
      .filter(([path, src]) => importsRawDb(path, src) && !ALLOWLIST.has(path))
      .map(([path]) => path)
      .sort();
    expect(
      offenders,
      `These modules import the raw D1 client, bypassing orgDb. Route them through ` +
        `orgDb/orgDbFor, or (if identity-only / a cross-org system job) add them to ` +
        `the allowlist WITH a reason:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("has no stale allowlist entries (each one still imports the client)", () => {
    const stale = [...ALLOWLIST]
      .filter((path) => {
        const src = sources[path];
        // A missing file (renamed/removed) is stale too.
        return src === undefined || !DB_CLIENT_IMPORT.test(src);
      })
      .sort();
    expect(
      stale,
      `These allowlist entries no longer import the raw client (folded through ` +
        `orgDb, or moved/renamed) — remove them from the allowlist:\n${stale.join("\n")}`,
    ).toEqual([]);
  });
});
