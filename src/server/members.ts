import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { hashPassword } from "better-auth/crypto";
import { and, desc, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import { type AuthEnv } from "./auth";
import { authPlugins, authSharedOptions } from "./auth-options";
import * as schema from "./db/schema";
import { accountLock, auditEvents, files } from "./db/schema";
import { buildDb } from "./db";
import { account, member, session, twoFactor, user } from "./db/auth-schema";
import { linkEmail, sendEmail } from "./email";

export type OrgRole = "owner" | "admin" | "member";

export class MemberError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface MemberRow {
  id: string; // membership id
  userId: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "member";
  status: "active" | "suspended";
  joinedAt: string; // ISO
}

export interface MemberListEnv {
  DB: D1Database;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * Roster of the active organization (spec 0005 AC-2, AC-15). `member` and
 * `invitation` are Better Auth tables, not covered by `orgDb`, so the
 * organization filter is written explicitly here and in every members query
 * (invariant 7). Ordered newest-first by the time-sortable membership id, with
 * opaque cursor pagination (the cursor is the last id returned).
 */
export async function listMembers(
  env: MemberListEnv,
  opts: { orgId: string; cursor?: string; limit?: number },
): Promise<{ members: MemberRow[]; nextCursor: string | null }> {
  const db = buildDb(env.DB);
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

  const where = opts.cursor
    ? and(eq(member.organizationId, opts.orgId), lt(member.id, opts.cursor))
    : eq(member.organizationId, opts.orgId);

  const rows = await db
    .select({
      id: member.id,
      userId: member.userId,
      role: member.role,
      status: member.status,
      createdAt: member.createdAt,
      name: user.name,
      email: user.email,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(where)
    .orderBy(desc(member.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    members: page.map((r) => ({
      id: r.id,
      userId: r.userId,
      name: r.name,
      email: r.email,
      role: (r.role as MemberRow["role"]) ?? "member",
      status: (r.status as MemberRow["status"]) ?? "active",
      joinedAt: new Date(r.createdAt).toISOString(),
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

interface MemberEnv {
  DB: D1Database;
}

/** A membership by id, only within this org (spec 0005 AC-14). */
async function getMemberInOrg(
  db: ReturnType<typeof buildDb>,
  orgId: string,
  memberId: string,
) {
  const [row] = await db
    .select()
    .from(member)
    .where(and(eq(member.id, memberId), eq(member.organizationId, orgId)))
    .limit(1);
  return row;
}

/** Count of OTHER active owners in the org (excludes `exceptMemberId`). */
async function countOtherActiveOwners(
  db: ReturnType<typeof buildDb>,
  orgId: string,
  exceptMemberId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(member)
    .where(
      and(
        eq(member.organizationId, orgId),
        eq(member.role, "owner"),
        eq(member.status, "active"),
        ne(member.id, exceptMemberId),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * True when this membership is the organization's last line of administration:
 * an active owner with no other active owner (invariant 1). Such a member cannot
 * be demoted, suspended, or removed (AC-5).
 */
async function isLastActiveOwner(
  db: ReturnType<typeof buildDb>,
  orgId: string,
  m: { id: string; role: string | null; status: string | null },
): Promise<boolean> {
  if (m.role !== "owner" || (m.status ?? "active") !== "active") return false;
  return (await countOtherActiveOwners(db, orgId, m.id)) === 0;
}

/**
 * Owner is a strictly higher tier than admin (spec 0021): only an owner may act
 * on an account that is currently an owner. Guards the account-security actions
 * (password set, reset link, session revoke, 2FA reset) so an admin cannot take
 * over or weaken an owner account. Throws 403 otherwise.
 */
function assertOwnerActionAllowed(
  actorRole: OrgRole,
  target: { role: string | null },
): void {
  if (target.role === "owner" && actorRole !== "owner") {
    throw new MemberError(403, "Only an owner can manage an owner's account.");
  }
}

/**
 * Change a member's role (spec 0005 AC-4). Guards: self (AC-6), last owner (AC-5),
 * and the owner-tier restriction (spec 0021): only an owner may grant the owner
 * role or change an account that is currently an owner.
 */
export async function changeMemberRole(opts: {
  env: MemberEnv;
  orgId: string;
  actorUserId: string;
  actorRole: OrgRole;
  memberId: string;
  newRole: OrgRole;
}): Promise<void> {
  const { env, orgId, actorUserId, actorRole, memberId, newRole } = opts;
  const db = buildDb(env.DB);
  const m = await getMemberInOrg(db, orgId, memberId);
  if (!m) throw new MemberError(404, "Member not found.");
  if (m.userId === actorUserId) {
    throw new MemberError(409, "You cannot change your own role.");
  }
  // Owner is a strictly higher tier than admin (spec 0021): only an owner may
  // mint another owner or alter an existing owner. Without this an admin could
  // promote a second account they control to owner and escalate.
  if (newRole === "owner" && actorRole !== "owner") {
    throw new MemberError(403, "Only an owner can grant the owner role.");
  }
  if (m.role === "owner" && actorRole !== "owner") {
    throw new MemberError(403, "Only an owner can change an owner's role.");
  }
  if (m.role === newRole) return; // no-op

  if (newRole !== "owner" && (await isLastActiveOwner(db, orgId, m))) {
    throw new MemberError(
      409,
      "This is the organization's last active owner and cannot be demoted.",
    );
  }

  await db
    .update(member)
    .set({ role: newRole })
    .where(and(eq(member.id, memberId), eq(member.organizationId, orgId)));
  await db.insert(auditEvents).values({
    orgId,
    actorUserId,
    action: "member.role_changed",
    targetType: "member",
    targetId: memberId,
    metadataJson: JSON.stringify({ before: m.role, after: newRole }),
  });
}

/**
 * Remove a membership (spec 0005 AC-9). Deletes only the `member` row — the user,
 * their files, every uploaded_by reference, and any published card are untouched.
 * Guards: self (AC-6), last owner (AC-5).
 */
export async function removeMember(opts: {
  env: MemberEnv;
  orgId: string;
  actorUserId: string;
  actorRole: OrgRole;
  memberId: string;
}): Promise<void> {
  const { env, orgId, actorUserId, actorRole, memberId } = opts;
  const db = buildDb(env.DB);
  const m = await getMemberInOrg(db, orgId, memberId);
  if (!m) throw new MemberError(404, "Member not found.");
  if (m.userId === actorUserId) {
    throw new MemberError(409, "You cannot remove your own account.");
  }
  // Only an owner may remove an owner (spec 0021).
  if (m.role === "owner" && actorRole !== "owner") {
    throw new MemberError(403, "Only an owner can remove an owner.");
  }
  if (await isLastActiveOwner(db, orgId, m)) {
    throw new MemberError(
      409,
      "This is the organization's last active owner and cannot be removed.",
    );
  }

  await db
    .delete(member)
    .where(and(eq(member.id, memberId), eq(member.organizationId, orgId)));
  await db.insert(auditEvents).values({
    orgId,
    actorUserId,
    action: "member.removed",
    targetType: "member",
    targetId: memberId,
    metadataJson: JSON.stringify({ userId: m.userId, role: m.role }),
  });
}

/**
 * Suspend or reactivate a member (spec 0005 AC-7, AC-8). Suspending revokes all
 * of that user's sessions in the same action (invariant 4). Guards: self (AC-6),
 * last active owner cannot be suspended (AC-5).
 */
export async function setMemberStatus(opts: {
  env: MemberEnv;
  orgId: string;
  actorUserId: string;
  actorRole: OrgRole;
  memberId: string;
  status: "active" | "suspended";
}): Promise<void> {
  const { env, orgId, actorUserId, actorRole, memberId, status } = opts;
  const db = buildDb(env.DB);
  const m = await getMemberInOrg(db, orgId, memberId);
  if (!m) throw new MemberError(404, "Member not found.");
  if (m.userId === actorUserId) {
    throw new MemberError(409, "You cannot change your own status.");
  }
  // Only an owner may suspend/reactivate an owner (spec 0021).
  if (m.role === "owner" && actorRole !== "owner") {
    throw new MemberError(403, "Only an owner can change an owner's status.");
  }
  if ((m.status ?? "active") === status) return; // no-op

  if (status === "suspended") {
    if (await isLastActiveOwner(db, orgId, m)) {
      throw new MemberError(
        409,
        "This is the organization's last active owner and cannot be suspended.",
      );
    }
    await db
      .update(member)
      .set({ status: "suspended" })
      .where(and(eq(member.id, memberId), eq(member.organizationId, orgId)));
    // Revoke every session for this user so the suspension takes effect now.
    await db.delete(session).where(eq(session.userId, m.userId));
    await db.insert(auditEvents).values({
      orgId,
      actorUserId,
      action: "member.suspended",
      targetType: "member",
      targetId: memberId,
    });
  } else {
    await db
      .update(member)
      .set({ status: "active" })
      .where(and(eq(member.id, memberId), eq(member.organizationId, orgId)));
    await db.insert(auditEvents).values({
      orgId,
      actorUserId,
      action: "member.reactivated",
      targetType: "member",
      targetId: memberId,
    });
  }
}

export interface MemberDetail {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: OrgRole;
  status: "active" | "suspended";
  joinedAt: string;
  signIn: {
    lastSignInAt: string | null;
    activeSessions: number;
    failedCount: number;
    lockedUntil: string | null;
  };
  storage: { files: number; bytes: number; published: number };
  security: { twoFactorEnabled: boolean; twoFactorRequired: boolean };
}

/**
 * Full detail for one member (spec 0005 AC-10): sign-in state, storage footprint,
 * and security posture. Org-scoped (AC-14). Aggregates are computed at read time.
 */
export async function getMemberDetail(
  env: MemberEnv,
  opts: { orgId: string; memberId: string },
): Promise<MemberDetail | null> {
  const db = buildDb(env.DB);
  const m = await getMemberInOrg(db, opts.orgId, opts.memberId);
  if (!m) return null;

  const [u] = await db
    .select({
      name: user.name,
      email: user.email,
      twoFactorEnabled: user.twoFactorEnabled,
    })
    .from(user)
    .where(eq(user.id, m.userId))
    .limit(1);

  const now = new Date();
  const [sess] = await db
    .select({
      last: sql<number | null>`max(${session.createdAt})`,
      active: sql<number>`sum(case when ${session.expiresAt} > ${now.getTime()} then 1 else 0 end)`,
    })
    .from(session)
    .where(eq(session.userId, m.userId));

  const [lock] = await db
    .select({
      failedCount: accountLock.failedCount,
      lockedUntil: accountLock.lockedUntil,
    })
    .from(accountLock)
    .where(eq(accountLock.userId, m.userId))
    .limit(1);

  const [footprint] = await db
    .select({
      files: sql<number>`count(*)`,
      bytes: sql<number>`coalesce(sum(${files.sizeBytes}), 0)`,
      published: sql<number>`sum(case when ${files.visibility} = 'public' then 1 else 0 end)`,
    })
    .from(files)
    .where(
      and(
        eq(files.orgId, opts.orgId),
        eq(files.uploadedBy, m.userId),
        isNull(files.deletedAt),
      ),
    );

  // twoFactorEnabled on the user is the source of truth; confirm a row exists too.
  const [tf] = await db
    .select({ id: twoFactor.id })
    .from(twoFactor)
    .where(eq(twoFactor.userId, m.userId))
    .limit(1);

  return {
    id: m.id,
    userId: m.userId,
    name: u?.name ?? "",
    email: u?.email ?? "",
    role: (m.role as OrgRole) ?? "member",
    status: (m.status as "active" | "suspended") ?? "active",
    joinedAt: new Date(m.createdAt).toISOString(),
    signIn: {
      lastSignInAt: sess?.last ? new Date(sess.last).toISOString() : null,
      activeSessions: Number(sess?.active ?? 0),
      failedCount: lock?.failedCount ?? 0,
      lockedUntil: lock?.lockedUntil
        ? new Date(lock.lockedUntil).toISOString()
        : null,
    },
    storage: {
      files: Number(footprint?.files ?? 0),
      bytes: Number(footprint?.bytes ?? 0),
      published: Number(footprint?.published ?? 0),
    },
    security: {
      twoFactorEnabled: Boolean(u?.twoFactorEnabled && tf),
      twoFactorRequired: Boolean(m.twoFactorRequired),
    },
  };
}

/** Admin-set whether a member must enrol two-factor before using the app (AC-11). */
export async function setMemberTwoFactorRequired(opts: {
  env: MemberEnv;
  orgId: string;
  actorUserId: string;
  memberId: string;
  required: boolean;
}): Promise<void> {
  const { env, orgId, actorUserId, memberId, required } = opts;
  const db = buildDb(env.DB);
  const m = await getMemberInOrg(db, orgId, memberId);
  if (!m) throw new MemberError(404, "Member not found.");

  await db
    .update(member)
    .set({ twoFactorRequired: required })
    .where(and(eq(member.id, memberId), eq(member.organizationId, orgId)));
  await db.insert(auditEvents).values({
    orgId,
    actorUserId,
    action: required
      ? "member.two_factor_required"
      : "member.two_factor_optional",
    targetType: "member",
    targetId: memberId,
  });
}

/** Revoke every session for a member's user (spec 0005 AC-11). Returns the count. */
export async function revokeMemberSessions(opts: {
  env: MemberEnv;
  orgId: string;
  actorUserId: string;
  actorRole: OrgRole;
  memberId: string;
}): Promise<number> {
  const { env, orgId, actorUserId, actorRole, memberId } = opts;
  const db = buildDb(env.DB);
  const m = await getMemberInOrg(db, orgId, memberId);
  if (!m) throw new MemberError(404, "Member not found.");
  assertOwnerActionAllowed(actorRole, m);

  const existing = await db
    .select({ id: session.id })
    .from(session)
    .where(eq(session.userId, m.userId));
  await db.delete(session).where(eq(session.userId, m.userId));

  await db.insert(auditEvents).values({
    orgId,
    actorUserId,
    action: "member.sessions_revoked",
    targetType: "member",
    targetId: memberId,
    metadataJson: JSON.stringify({ revoked: existing.length }),
  });
  return existing.length;
}

/**
 * Reset a member's second factor (spec 0005 AC-11): delete the twoFactor row and
 * clear the flag so they must enrol again on next sign-in.
 */
export async function resetMemberTwoFactor(opts: {
  env: MemberEnv;
  orgId: string;
  actorUserId: string;
  actorRole: OrgRole;
  memberId: string;
}): Promise<void> {
  const { env, orgId, actorUserId, actorRole, memberId } = opts;
  const db = buildDb(env.DB);
  const m = await getMemberInOrg(db, orgId, memberId);
  if (!m) throw new MemberError(404, "Member not found.");
  assertOwnerActionAllowed(actorRole, m);

  await db.delete(twoFactor).where(eq(twoFactor.userId, m.userId));
  await db
    .update(user)
    .set({ twoFactorEnabled: false })
    .where(eq(user.id, m.userId));
  await db.insert(auditEvents).values({
    orgId,
    actorUserId,
    action: "member.two_factor_reset",
    targetType: "member",
    targetId: memberId,
  });
}

const MIN_PASSWORD_LENGTH = 12; // matches authSharedOptions.emailAndPassword

/**
 * Admin-set a member's password (scope extension beyond spec 0005, which chose
 * self-service only). Hashes with Better Auth's own hasher, updates the
 * credential account, and revokes the member's sessions so the new password
 * takes effect everywhere. Audited as `member.password_set`.
 */
export async function adminSetPassword(opts: {
  env: AuthEnv;
  orgId: string;
  actorUserId: string;
  actorRole: OrgRole;
  memberId: string;
  newPassword: string;
}): Promise<void> {
  const { env, orgId, actorUserId, actorRole, memberId, newPassword } = opts;
  const db = buildDb(env.DB);
  const m = await getMemberInOrg(db, orgId, memberId);
  if (!m) throw new MemberError(404, "Member not found.");
  // An admin setting an owner's password would be a direct account takeover (spec 0021).
  assertOwnerActionAllowed(actorRole, m);
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new MemberError(
      400,
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }

  const hash = await hashPassword(newPassword);

  const updated = await db
    .update(account)
    .set({ password: hash })
    .where(
      and(eq(account.userId, m.userId), eq(account.providerId, "credential")),
    )
    .returning({ id: account.id });
  if (updated.length === 0) {
    throw new MemberError(409, "This member has no password login to reset.");
  }

  await db.delete(session).where(eq(session.userId, m.userId));
  await db.insert(auditEvents).values({
    orgId,
    actorUserId,
    action: "member.password_set",
    targetType: "member",
    targetId: memberId,
  });
}

/**
 * Send (and return) a password-reset link for a member (scope extension). Uses
 * Better Auth's own forget-password flow so the token, expiry, and single use
 * are its responsibility; the link is emailed AND returned so an admin can share
 * it directly while email delivery is unconfigured. Audited.
 */
export async function sendMemberResetLink(opts: {
  env: AuthEnv;
  orgId: string;
  actorUserId: string;
  actorRole: OrgRole;
  memberId: string;
}): Promise<{ email: string; url: string | null }> {
  const { env, orgId, actorUserId, actorRole, memberId } = opts;
  const db = buildDb(env.DB);
  const m = await getMemberInOrg(db, orgId, memberId);
  if (!m) throw new MemberError(404, "Member not found.");
  // Returning an owner's reset link to an admin would be an account takeover (spec 0021).
  assertOwnerActionAllowed(actorRole, m);
  const [u] = await db
    .select({ email: user.email, name: user.name })
    .from(user)
    .where(eq(user.id, m.userId))
    .limit(1);
  if (!u) throw new MemberError(404, "Member not found.");

  let capturedUrl: string | null = null;
  const auth = betterAuth({
    ...authSharedOptions,
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.APP_URL,
    plugins: authPlugins,
    emailAndPassword: {
      ...authSharedOptions.emailAndPassword,
      sendResetPassword: async ({ url }) => {
        capturedUrl = url;
        await sendEmail(
          {
            apiKey: env.RESEND_API_KEY,
            from: env.EMAIL_FROM ?? "no-reply@americaworks.com",
          },
          {
            to: u.email,
            subject: "Reset your password",
            html: linkEmail(
              "An administrator asked you to reset your AW File Storage password. Use the button below to choose a new one.",
              url,
              "Reset password",
              u.name,
            ),
          },
        );
      },
    },
  });
  await auth.api.requestPasswordReset({
    body: { email: u.email, redirectTo: `${env.APP_URL}/reset-password` },
  });

  await db.insert(auditEvents).values({
    orgId,
    actorUserId,
    action: "member.password_reset_sent",
    targetType: "member",
    targetId: memberId,
  });
  return { email: u.email, url: capturedUrl };
}

/**
 * Whether the account for `email` is barred from signing in because every one of
 * its memberships is suspended (spec 0005 AC-7). A user with at least one active
 * membership, or with no membership at all, is not "suspended" here.
 */
export async function isSuspendedEverywhere(
  env: MemberEnv,
  email: string,
): Promise<boolean> {
  const db = buildDb(env.DB);
  const [u] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email.toLowerCase()))
    .limit(1);
  if (!u) return false;

  const [anyMembership] = await db
    .select({ id: member.id })
    .from(member)
    .where(eq(member.userId, u.id))
    .limit(1);
  if (!anyMembership) return false; // no membership at all — not a suspension

  const [active] = await db
    .select({ id: member.id })
    .from(member)
    .where(
      and(
        eq(member.userId, u.id),
        or(eq(member.status, "active"), isNull(member.status)),
      ),
    )
    .limit(1);
  return !active;
}
