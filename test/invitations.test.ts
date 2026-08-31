import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthEnv } from "../src/server/auth";
import { buildDb } from "../src/server/db";
import { invitation, member, organization, user } from "../src/server/db/auth-schema";
import { auditEvents } from "../src/server/db/schema";
import { acceptInvite } from "../src/server/invitations";

const db = buildDb(env.DB);
// acceptInvite constructs a Better Auth instance; these satisfy AuthEnv. The
// existing-user paths below never call sign-up, so no real auth work happens.
const AUTH_ENV: AuthEnv = {
  DB: env.DB,
  BETTER_AUTH_SECRET: "test-secret-0000000000000000000000000000",
  APP_URL: "http://localhost:3000",
};

const now = () => new Date();
const future = () => new Date(Date.now() + 60_000);

async function seed() {
  await db.delete(auditEvents);
  await db.delete(invitation);
  await db.delete(member);
  await db.delete(organization);
  await db.delete(user);

  await db.insert(user).values([
    { id: "u-owner", name: "Owner", email: "owner@x.com", emailVerified: true, createdAt: now(), updatedAt: now() },
    // Already active elsewhere (org-b), so the accept path skips sign-up + password reset.
    { id: "u-invitee", name: "Old Name", email: "invitee@x.com", emailVerified: true, createdAt: now(), updatedAt: now() },
  ]);
  await db.insert(organization).values([
    { id: "org-a", name: "A", slug: "a", createdAt: now() },
    { id: "org-b", name: "B", slug: "b", createdAt: now() },
  ]);
  await db.insert(member).values([
    { id: "m-owner", organizationId: "org-a", userId: "u-owner", role: "owner", createdAt: now(), status: "active" },
    { id: "m-invitee-b", organizationId: "org-b", userId: "u-invitee", role: "member", createdAt: now(), status: "active" },
  ]);
}

beforeEach(seed);

async function membersIn(orgId: string, userId: string) {
  return db
    .select()
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)));
}

describe("acceptInvite atomicity (spec 0005)", () => {
  it("commits membership + accepted invitation + audit together", async () => {
    await db.insert(invitation).values({
      id: "inv-1",
      organizationId: "org-a",
      email: "invitee@x.com",
      role: "member",
      status: "pending",
      expiresAt: future(),
      inviterId: "u-owner",
      createdAt: now(),
    });

    const result = await acceptInvite({
      env: AUTH_ENV,
      invitationId: "inv-1",
      name: "Invited User",
      password: "correct-horse-battery-staple-12",
    });
    expect(result).toEqual({ email: "invitee@x.com", orgId: "org-a" });

    // Membership added to org-a with the invited role.
    const rows = await membersIn("org-a", "u-invitee");
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("member");

    // Invitation consumed.
    const [inv] = await db.select().from(invitation).where(eq(invitation.id, "inv-1"));
    expect(inv.status).toBe("accepted");

    // Join audited against the new membership.
    const audits = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.orgId, "org-a"), eq(auditEvents.action, "member.joined")));
    expect(audits).toHaveLength(1);
    expect(audits[0].targetId).toBe(rows[0].id);
  });

  it("is idempotent when the user is already a member (no duplicate)", async () => {
    // Invitee is already in org-a.
    await db.insert(member).values({
      id: "m-invitee-a",
      organizationId: "org-a",
      userId: "u-invitee",
      role: "member",
      createdAt: now(),
      status: "active",
    });
    await db.insert(invitation).values({
      id: "inv-2",
      organizationId: "org-a",
      email: "invitee@x.com",
      role: "admin",
      status: "pending",
      expiresAt: future(),
      inviterId: "u-owner",
      createdAt: now(),
    });

    await acceptInvite({
      env: AUTH_ENV,
      invitationId: "inv-2",
      name: "Invited User",
      password: "correct-horse-battery-staple-12",
    });

    // Still exactly one membership in org-a (not duplicated).
    const rows = await membersIn("org-a", "u-invitee");
    expect(rows).toHaveLength(1);

    // Invitation still consumed and the join audited.
    const [inv] = await db.select().from(invitation).where(eq(invitation.id, "inv-2"));
    expect(inv.status).toBe("accepted");
    const audits = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.orgId, "org-a"), eq(auditEvents.action, "member.joined")));
    expect(audits).toHaveLength(1);
  });

  it("rejects an expired invitation before writing anything", async () => {
    await db.insert(invitation).values({
      id: "inv-3",
      organizationId: "org-a",
      email: "invitee@x.com",
      role: "member",
      status: "pending",
      expiresAt: new Date(Date.now() - 60_000),
      inviterId: "u-owner",
      createdAt: now(),
    });

    await expect(
      acceptInvite({
        env: AUTH_ENV,
        invitationId: "inv-3",
        name: "Invited User",
        password: "correct-horse-battery-staple-12",
      }),
    ).rejects.toThrow(/expired/i);

    // No membership created in org-a.
    const rows = await membersIn("org-a", "u-invitee");
    expect(rows).toHaveLength(0);
  });
});
