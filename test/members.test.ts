import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { buildDb } from "../src/server/db";
import { member, organization, session, user } from "../src/server/db/auth-schema";
import { auditEvents } from "../src/server/db/schema";
import {
  changeMemberRole,
  MemberError,
  removeMember,
  resetMemberTwoFactor,
  revokeMemberSessions,
  setMemberStatus,
} from "../src/server/members";

const db = buildDb(env.DB);
const ENV = { DB: env.DB };

// Ids: org-a holds two owners + one member; org-b is a separate org.
const now = () => new Date();

async function seed() {
  await db.delete(auditEvents);
  await db.delete(session);
  await db.delete(member);
  await db.delete(organization);
  await db.delete(user);

  await db.insert(user).values([
    { id: "u-owner1", name: "Owner One", email: "o1@x.com", emailVerified: true, createdAt: now(), updatedAt: now() },
    { id: "u-owner2", name: "Owner Two", email: "o2@x.com", emailVerified: true, createdAt: now(), updatedAt: now() },
    { id: "u-admin", name: "Admin", email: "adm@x.com", emailVerified: true, createdAt: now(), updatedAt: now() },
    { id: "u-mem", name: "Member", email: "m@x.com", emailVerified: true, createdAt: now(), updatedAt: now() },
    { id: "u-b", name: "B Owner", email: "b@x.com", emailVerified: true, createdAt: now(), updatedAt: now() },
  ]);
  await db.insert(organization).values([
    { id: "org-a", name: "A", slug: "a", createdAt: now() },
    { id: "org-b", name: "B", slug: "b", createdAt: now() },
  ]);
  await db.insert(member).values([
    { id: "m-owner1", organizationId: "org-a", userId: "u-owner1", role: "owner", createdAt: now(), status: "active" },
    { id: "m-owner2", organizationId: "org-a", userId: "u-owner2", role: "owner", createdAt: now(), status: "active" },
    { id: "m-admin", organizationId: "org-a", userId: "u-admin", role: "admin", createdAt: now(), status: "active" },
    { id: "m-mem", organizationId: "org-a", userId: "u-mem", role: "member", createdAt: now(), status: "active" },
    { id: "m-b", organizationId: "org-b", userId: "u-b", role: "owner", createdAt: now(), status: "active" },
  ]);
}

beforeEach(seed);

async function roleOf(memberId: string) {
  const [m] = await db.select({ role: member.role, status: member.status }).from(member).where(eq(member.id, memberId));
  return m;
}

describe("member management guards (spec 0005)", () => {
  it("AC-6: cannot change your own role or remove yourself", async () => {
    await expect(
      changeMemberRole({ env: ENV, orgId: "org-a", actorUserId: "u-owner1", actorRole: "owner", memberId: "m-owner1", newRole: "admin" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      removeMember({ env: ENV, orgId: "org-a", actorUserId: "u-mem", actorRole: "member", memberId: "m-mem" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("AC-5: the last active owner cannot be demoted, suspended, or removed", async () => {
    // Suspend owner2 so owner1 is the only active owner.
    await setMemberStatus({ env: ENV, orgId: "org-a", actorUserId: "u-owner1", actorRole: "owner", memberId: "m-owner2", status: "suspended" });

    // owner2 (still an owner, just suspended) tries to demote/suspend/remove the last active owner.
    await expect(
      changeMemberRole({ env: ENV, orgId: "org-a", actorUserId: "u-owner2", actorRole: "owner", memberId: "m-owner1", newRole: "admin" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      setMemberStatus({ env: ENV, orgId: "org-a", actorUserId: "u-owner2", actorRole: "owner", memberId: "m-owner1", status: "suspended" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      removeMember({ env: ENV, orgId: "org-a", actorUserId: "u-owner2", actorRole: "owner", memberId: "m-owner1" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("AC-4/AC-5: an owner CAN be demoted while another active owner exists", async () => {
    await changeMemberRole({ env: ENV, orgId: "org-a", actorUserId: "u-owner1", actorRole: "owner", memberId: "m-owner2", newRole: "admin" });
    expect((await roleOf("m-owner2"))?.role).toBe("admin");
  });

  it("AC-14: a member id from another org is not found", async () => {
    await expect(
      changeMemberRole({ env: ENV, orgId: "org-a", actorUserId: "u-owner1", actorRole: "owner", memberId: "m-b", newRole: "member" }),
    ).rejects.toMatchObject({ status: 404 });
    // org-b is untouched.
    expect((await roleOf("m-b"))?.role).toBe("owner");
  });

  it("AC-7: suspending a member revokes their sessions", async () => {
    await db.insert(session).values({
      id: "s1", token: "t1", userId: "u-mem",
      expiresAt: new Date(Date.now() + 3_600_000), createdAt: now(), updatedAt: now(),
    });
    await setMemberStatus({ env: ENV, orgId: "org-a", actorUserId: "u-owner1", actorRole: "owner", memberId: "m-mem", status: "suspended" });

    expect((await roleOf("m-mem"))?.status).toBe("suspended");
    const sessions = await db.select().from(session).where(eq(session.userId, "u-mem"));
    expect(sessions).toHaveLength(0);
  });

  it("AC-12: a role change writes exactly one audit row with before/after", async () => {
    await changeMemberRole({ env: ENV, orgId: "org-a", actorUserId: "u-owner1", actorRole: "owner", memberId: "m-mem", newRole: "admin" });
    const rows = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "member.role_changed"), eq(auditEvents.targetId, "m-mem")));
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].metadataJson ?? "{}")).toMatchObject({ before: "member", after: "admin" });
  });
});

describe("owner-tier authorization (spec 0021)", () => {
  it("AC-1: an admin cannot grant the owner role", async () => {
    await expect(
      changeMemberRole({ env: ENV, orgId: "org-a", actorUserId: "u-admin", actorRole: "admin", memberId: "m-mem", newRole: "owner" }),
    ).rejects.toMatchObject({ status: 403 });
    // The member is untouched.
    expect((await roleOf("m-mem"))?.role).toBe("member");
  });

  it("AC-2: an admin cannot change, suspend, or remove an owner", async () => {
    await expect(
      changeMemberRole({ env: ENV, orgId: "org-a", actorUserId: "u-admin", actorRole: "admin", memberId: "m-owner2", newRole: "member" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      setMemberStatus({ env: ENV, orgId: "org-a", actorUserId: "u-admin", actorRole: "admin", memberId: "m-owner2", status: "suspended" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      removeMember({ env: ENV, orgId: "org-a", actorUserId: "u-admin", actorRole: "admin", memberId: "m-owner2" }),
    ).rejects.toMatchObject({ status: 403 });
    // owner2 is untouched.
    expect((await roleOf("m-owner2"))?.role).toBe("owner");
    expect((await roleOf("m-owner2"))?.status).toBe("active");
  });

  it("AC-1: an owner CAN grant the owner role", async () => {
    await changeMemberRole({ env: ENV, orgId: "org-a", actorUserId: "u-owner1", actorRole: "owner", memberId: "m-mem", newRole: "owner" });
    expect((await roleOf("m-mem"))?.role).toBe("owner");
  });

  it("AC-3: an admin can still manage member↔admin transitions", async () => {
    await changeMemberRole({ env: ENV, orgId: "org-a", actorUserId: "u-admin", actorRole: "admin", memberId: "m-mem", newRole: "admin" });
    expect((await roleOf("m-mem"))?.role).toBe("admin");
    await setMemberStatus({ env: ENV, orgId: "org-a", actorUserId: "u-admin", actorRole: "admin", memberId: "m-mem", status: "suspended" });
    expect((await roleOf("m-mem"))?.status).toBe("suspended");
  });

  it("AC-2: an admin cannot revoke sessions or reset 2FA on an owner", async () => {
    await expect(
      revokeMemberSessions({ env: ENV, orgId: "org-a", actorUserId: "u-admin", actorRole: "admin", memberId: "m-owner2" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      resetMemberTwoFactor({ env: ENV, orgId: "org-a", actorUserId: "u-admin", actorRole: "admin", memberId: "m-owner2" }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("AC-2: an owner CAN revoke an owner's sessions", async () => {
    // No sessions seeded, so this simply proves the guard allows an owner actor.
    const revoked = await revokeMemberSessions({ env: ENV, orgId: "org-a", actorUserId: "u-owner1", actorRole: "owner", memberId: "m-owner2" });
    expect(revoked).toBe(0);
  });
});
