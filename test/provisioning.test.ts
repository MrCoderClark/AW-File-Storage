import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthEnv } from "../src/server/auth";
import { buildDb } from "../src/server/db";
import {
  auditEvents,
  member,
  organization,
  orgDomains,
  provision,
  user,
} from "../src/server/db/schema";
import { domainOf, isConsumerDomain, resolveOrgForEmail } from "../src/server/domains";
import {
  acceptProvision,
  assignExistingUser,
  createProvision,
  lookupEmail,
  suggestOrgForEmail,
} from "../src/server/provisioning";

const db = buildDb(env.DB);
const AUTH_ENV: AuthEnv = {
  DB: env.DB,
  BETTER_AUTH_SECRET: "test-secret-0000000000000000000000000000",
  APP_URL: "http://localhost:3000",
  // no RESEND_API_KEY → sendEmail no-ops (logs), so createProvision is safe in tests.
};

const now = () => new Date();
const future = () => new Date(Date.now() + 60_000);

async function seed() {
  await db.delete(auditEvents);
  await db.delete(provision);
  await db.delete(orgDomains);
  await db.delete(member);
  await db.delete(organization);
  await db.delete(user);
  await db.insert(user).values([
    { id: "u-owner", name: "Owner", email: "owner@h2tecs.com", emailVerified: true, createdAt: now(), updatedAt: now() },
    // Already active in org-b, so accept/assign never hit sign-up and dedupe is testable.
    { id: "u-existing", name: "Existing", email: "existing@h2tecs.com", emailVerified: true, createdAt: now(), updatedAt: now() },
  ]);
  await db.insert(organization).values([
    { id: "org-a", name: "A", slug: "a", createdAt: now() },
    { id: "org-b", name: "B", slug: "b", createdAt: now() },
  ]);
  await db.insert(member).values({
    id: "m-existing-b", organizationId: "org-b", userId: "u-existing", role: "member", createdAt: now(), status: "active",
  });
  // h2tecs.com is org-a's verified domain.
  await db.insert(orgDomains).values({
    id: "d1", orgId: "org-a", domain: "h2tecs.com", source: "manual", verifiedAt: now(), createdAt: now(),
  });
}
beforeEach(seed);

const membersIn = (orgId: string, userId: string) =>
  db.select().from(member).where(and(eq(member.organizationId, orgId), eq(member.userId, userId)));

describe("domain resolution (spec 0014)", () => {
  it("parses the domain and blocks consumer providers", () => {
    expect(domainOf("A@H2TECS.com")).toBe("h2tecs.com");
    expect(isConsumerDomain("gmail.com")).toBe(true);
    expect(isConsumerDomain("h2tecs.com")).toBe(false);
  });

  it("maps a verified domain to its org, never a consumer/unknown domain", async () => {
    expect((await resolveOrgForEmail(AUTH_ENV, "new@h2tecs.com"))?.orgId).toBe("org-a");
    expect(await resolveOrgForEmail(AUTH_ENV, "x@gmail.com")).toBeNull();
    expect(await resolveOrgForEmail(AUTH_ENV, "x@unknown.com")).toBeNull();
  });

  it("suggestOrgForEmail pre-selects the domain's org", async () => {
    expect((await suggestOrgForEmail(AUTH_ENV, "new@h2tecs.com"))?.orgId).toBe("org-a");
  });

  it("lookupEmail reports match, existing memberships, and account existence", async () => {
    const existing = await lookupEmail(AUTH_ENV, "existing@h2tecs.com");
    expect(existing.match?.orgId).toBe("org-a");
    expect(existing.existingOrgIds).toEqual(["org-b"]); // already a member of org-b
    expect(existing.accountExists).toBe(true);

    const fresh = await lookupEmail(AUTH_ENV, "brand-new@h2tecs.com");
    expect(fresh.match?.orgId).toBe("org-a");
    expect(fresh.existingOrgIds).toEqual([]);
    expect(fresh.accountExists).toBe(false);
  });
});

describe("provisioning (spec 0014)", () => {
  it("createProvision records a pending, multi-org provision for a new address", async () => {
    const { id } = await createProvision({
      env: AUTH_ENV,
      email: "brand-new@h2tecs.com",
      assignments: [{ orgId: "org-a", role: "member" }],
      createdBy: "u-owner",
    });
    const [p] = await db.select().from(provision).where(eq(provision.id, id));
    expect(p.status).toBe("pending");
    expect(JSON.parse(p.assignments)).toEqual([{ orgId: "org-a", role: "member" }]);
  });

  it("createProvision drops orgs the user already belongs to (all → error)", async () => {
    await expect(
      createProvision({
        env: AUTH_ENV,
        email: "existing@h2tecs.com",
        assignments: [{ orgId: "org-b", role: "member" }],
        createdBy: "u-owner",
      }),
    ).rejects.toThrow(/already a member/i);
  });

  it("accepts a multi-org provision: adds all new memberships, skips dupes, marks accepted", async () => {
    await db.insert(provision).values({
      id: "p1",
      email: "existing@h2tecs.com",
      status: "pending",
      expiresAt: future(),
      assignments: JSON.stringify([
        { orgId: "org-a", role: "member" },
        { orgId: "org-b", role: "admin" }, // already a member → skipped (stays 'member')
      ]),
      createdBy: "u-owner",
      createdAt: now(),
    });
    const res = await acceptProvision({
      env: AUTH_ENV, provisionId: "p1", name: "Existing", password: "correct-horse-battery-staple-12",
    });
    expect(res.email).toBe("existing@h2tecs.com");

    const a = await membersIn("org-a", "u-existing");
    expect(a).toHaveLength(1);
    expect(a[0].role).toBe("member");
    const b = await membersIn("org-b", "u-existing");
    expect(b).toHaveLength(1);
    expect(b[0].role).toBe("member"); // unchanged — dupe skipped, not upgraded

    const [p] = await db.select().from(provision).where(eq(provision.id, "p1"));
    expect(p.status).toBe("accepted");
    const joins = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.orgId, "org-a"), eq(auditEvents.action, "member.joined")));
    expect(joins).toHaveLength(1);
  });

  it("assignExistingUser adds memberships directly and skips duplicates", async () => {
    const r = await assignExistingUser({
      env: AUTH_ENV,
      email: "existing@h2tecs.com",
      assignments: [
        { orgId: "org-a", role: "admin" },
        { orgId: "org-b", role: "admin" }, // dupe → skipped
      ],
      actorUserId: "u-owner",
    });
    expect(r.added).toBe(1);
    const a = await membersIn("org-a", "u-existing");
    expect(a).toHaveLength(1);
    expect(a[0].role).toBe("admin");
  });

  it("assignExistingUser refuses an unknown account", async () => {
    await expect(
      assignExistingUser({
        env: AUTH_ENV, email: "nobody@h2tecs.com", assignments: [{ orgId: "org-a", role: "member" }], actorUserId: "u-owner",
      }),
    ).rejects.toThrow(/no existing account/i);
  });
});
