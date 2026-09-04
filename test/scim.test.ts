import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { buildDb } from "../src/server/db";
import {
  member,
  organization,
  pendingEmail,
  session,
  user,
} from "../src/server/db/schema";
import {
  resolveScimOrg,
  type ScimEnv,
  scimCreateUser,
  scimDeleteUser,
  scimGetUser,
  scimListUsers,
  scimSetActive,
  setOrgScimToken,
  disableOrgScimToken,
} from "../src/server/scim";

const db = buildDb(env.DB);
const SCIM_ENV: ScimEnv = {
  DB: env.DB,
  BETTER_AUTH_SECRET: "test-secret-0000000000000000000000000000",
  APP_URL: "http://localhost:3000",
};

const now = () => new Date();

async function seed() {
  await db.delete(pendingEmail);
  await db.delete(session);
  await db.delete(member);
  await db.delete(organization);
  await db.delete(user);
  await db.insert(user).values([
    { id: "u-owner", name: "Owner", email: "owner@h2tecs.com", emailVerified: true, createdAt: now(), updatedAt: now() },
    { id: "u-existing", name: "Existing User", email: "existing@h2tecs.com", emailVerified: true, createdAt: now(), updatedAt: now() },
    { id: "u-other", name: "Other Co", email: "other@acme.com", emailVerified: true, createdAt: now(), updatedAt: now() },
  ]);
  await db.insert(organization).values([
    { id: "org-a", name: "A", slug: "a", createdAt: now() },
    { id: "org-b", name: "B", slug: "b", createdAt: now() },
  ]);
  await db.insert(member).values([
    { id: "m-existing-a", organizationId: "org-a", userId: "u-existing", role: "member", createdAt: now(), status: "active" },
    { id: "m-other-b", organizationId: "org-b", userId: "u-other", role: "member", createdAt: now(), status: "active" },
  ]);
}
beforeEach(seed);

const membersIn = (orgId: string, userId: string) =>
  db.select().from(member).where(and(eq(member.organizationId, orgId), eq(member.userId, userId)));

describe("SCIM token auth (spec 0015)", () => {
  it("a generated token resolves to its org; wrong/disabled tokens do not", async () => {
    const token = await setOrgScimToken(SCIM_ENV, "org-a", "u-owner");
    expect(await resolveScimOrg(SCIM_ENV, `Bearer ${token}`)).toBe("org-a");
    expect(await resolveScimOrg(SCIM_ENV, "Bearer not-a-real-token")).toBeNull();
    expect(await resolveScimOrg(SCIM_ENV, null)).toBeNull();

    await disableOrgScimToken(SCIM_ENV, "org-a");
    expect(await resolveScimOrg(SCIM_ENV, `Bearer ${token}`)).toBeNull();
  });

  it("rotating replaces the token (old one stops working)", async () => {
    const first = await setOrgScimToken(SCIM_ENV, "org-a", "u-owner");
    const second = await setOrgScimToken(SCIM_ENV, "org-a", "u-owner");
    expect(second).not.toBe(first);
    expect(await resolveScimOrg(SCIM_ENV, `Bearer ${first}`)).toBeNull();
    expect(await resolveScimOrg(SCIM_ENV, `Bearer ${second}`)).toBe("org-a");
  });
});

describe("SCIM user operations (spec 0015)", () => {
  it("create adds a member membership for an existing account, no hijack/email", async () => {
    // 'existing' has an account (member of org-a). SCIM-provisioning them into org-b
    // just adds a membership — never a new account, never a queued set-password email.
    const u = await scimCreateUser(SCIM_ENV, "org-b", { userName: "existing@h2tecs.com" });
    expect(u.id).toBe("u-existing");
    const inB = await membersIn("org-b", "u-existing");
    expect(inB).toHaveLength(1);
    expect(inB[0].role).toBe("member");
    // No set-password email queued for a pre-existing account.
    const queued = await db.select().from(pendingEmail).where(eq(pendingEmail.userId, "u-existing"));
    expect(queued).toHaveLength(0);
  });

  it("deactivate suspends the membership and revokes sessions", async () => {
    await db.insert(session).values({
      id: "s1", token: "t1", userId: "u-existing", expiresAt: new Date(Date.now() + 3600_000), createdAt: now(), updatedAt: now(),
    });
    await scimSetActive(SCIM_ENV, "org-a", "u-existing", false);
    const [m] = await membersIn("org-a", "u-existing");
    expect(m.status).toBe("suspended");
    const sessions = await db.select().from(session).where(eq(session.userId, "u-existing"));
    expect(sessions).toHaveLength(0); // revoked

    await scimSetActive(SCIM_ENV, "org-a", "u-existing", true);
    const [m2] = await membersIn("org-a", "u-existing");
    expect(m2.status).toBe("active");
  });

  it("is confined to the token's org (no cross-org read/modify)", async () => {
    // org-a's SCIM only ever sees org-a members.
    const listA = await scimListUsers(SCIM_ENV, "org-a");
    expect(listA.map((u) => u.id)).toEqual(["u-existing"]);
    expect(listA.map((u) => u.id)).not.toContain("u-other");
    // A filter for another org's user returns nothing from org-a's scope.
    expect(await scimListUsers(SCIM_ENV, "org-a", "other@acme.com")).toHaveLength(0);
    // Fetching org-b's user via org-a returns null.
    expect(await scimGetUser(SCIM_ENV, "org-a", "u-other")).toBeNull();
  });

  it("delete removes the membership (keeps the account)", async () => {
    const removed = await scimDeleteUser(SCIM_ENV, "org-a", "u-existing");
    expect(removed).toBe(true);
    expect(await membersIn("org-a", "u-existing")).toHaveLength(0);
    // The account survives.
    const [u] = await db.select().from(user).where(eq(user.id, "u-existing"));
    expect(u).toBeTruthy();
  });
});
