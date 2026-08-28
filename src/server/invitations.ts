import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { authPlugins, authSharedOptions } from "./auth-options";
import { type AuthEnv } from "./auth";
import { buildDb } from "./db";
import * as schema from "./db/schema";
import { linkEmail, sendEmail } from "./email";
import { uuidv7 } from "./id";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (spec 0001 AC-10)

export type InviteRole = "admin" | "member";

export type InvitePreview =
  | { status: "valid"; email: string; role: InviteRole }
  | { status: "invalid" | "expired" | "used" };

/**
 * Read-only check of an invitation by its (unguessable) id, for the public
 * accept page (spec 0005 AC-1). Reveals the invited email ONLY when the id maps
 * to a live, pending invitation — a wrong/expired/used id learns nothing.
 */
export async function previewInvite(
  env: AuthEnv,
  invitationId: string,
): Promise<InvitePreview> {
  const db = buildDb(env.DB);
  const [inv] = await db
    .select()
    .from(schema.invitation)
    .where(eq(schema.invitation.id, invitationId))
    .limit(1);
  if (!inv) return { status: "invalid" };
  if (inv.status === "accepted") return { status: "used" };
  if (inv.status !== "pending") return { status: "invalid" }; // cancelled, etc.
  if (new Date(inv.expiresAt).getTime() < Date.now()) return { status: "expired" };
  return {
    status: "valid",
    email: inv.email,
    role: (inv.role ?? "member") as InviteRole,
  };
}

/**
 * Create and email an invitation. Sign-up is disabled globally, so this is the
 * only way a new account is created: the invite reserves an email + role for an
 * organization, and acceptInvite() below turns it into an account.
 */
export async function createInvite(opts: {
  env: AuthEnv;
  orgId: string;
  inviterId: string;
  email: string;
  role: InviteRole;
}): Promise<{ id: string; url: string }> {
  const { env, orgId, inviterId, role } = opts;
  const email = opts.email.toLowerCase();
  const db = buildDb(env.DB);

  // Already a member of this org?
  const existingMember = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.user.email, email)))
    .limit(1);
  if (existingMember.length > 0) {
    throw new Error("That person is already a member of this organization.");
  }

  // An outstanding invite for this org+email?
  const pending = await db
    .select({ id: schema.invitation.id })
    .from(schema.invitation)
    .where(
      and(
        eq(schema.invitation.organizationId, orgId),
        eq(schema.invitation.email, email),
        eq(schema.invitation.status, "pending"),
      ),
    )
    .limit(1);
  if (pending.length > 0) {
    throw new Error("An invitation for that email is already pending.");
  }

  const id = uuidv7();
  await db.insert(schema.invitation).values({
    id,
    organizationId: orgId,
    email,
    role,
    status: "pending",
    expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    inviterId,
    createdAt: new Date(),
  });

  await db.insert(schema.auditEvents).values({
    orgId,
    actorUserId: inviterId,
    action: "member.invited",
    targetType: "invitation",
    targetId: id,
    metadataJson: JSON.stringify({ email, role }),
  });

  const url = `${env.APP_URL}/accept-invitation/${id}`;
  await sendEmail(
    { apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM ?? "no-reply@americaworks.com" },
    {
      to: email,
      subject: "You're invited to AW File Storage",
      html: linkEmail("You've been invited. Set a password to join:", url, "Accept invitation"),
    },
  );

  return { id, url };
}

export interface PendingInvitation {
  id: string;
  email: string;
  role: InviteRole;
  expiresAt: string; // ISO
  createdAt: string; // ISO
}

/** Pending invitations for the org, newest-first, with cursor pagination (AC-3, AC-15). */
export async function listInvitations(
  env: AuthEnv,
  opts: { orgId: string; cursor?: string; limit?: number },
): Promise<{ invitations: PendingInvitation[]; nextCursor: string | null }> {
  const db = buildDb(env.DB);
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 100);
  const where = opts.cursor
    ? and(
        eq(schema.invitation.organizationId, opts.orgId),
        eq(schema.invitation.status, "pending"),
        lt(schema.invitation.id, opts.cursor),
      )
    : and(
        eq(schema.invitation.organizationId, opts.orgId),
        eq(schema.invitation.status, "pending"),
      );

  const rows = await db
    .select({
      id: schema.invitation.id,
      email: schema.invitation.email,
      role: schema.invitation.role,
      expiresAt: schema.invitation.expiresAt,
      createdAt: schema.invitation.createdAt,
    })
    .from(schema.invitation)
    .where(where)
    .orderBy(desc(schema.invitation.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    invitations: page.map((r) => ({
      id: r.id,
      email: r.email,
      role: (r.role ?? "member") as InviteRole,
      expiresAt: new Date(r.expiresAt).toISOString(),
      createdAt: new Date(r.createdAt).toISOString(),
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

/** Revoke a pending invitation: status → cancelled, so its link stops working (AC-3). */
export async function revokeInvitation(opts: {
  env: AuthEnv;
  orgId: string;
  actorUserId: string;
  invitationId: string;
}): Promise<void> {
  const { env, orgId, actorUserId, invitationId } = opts;
  const db = buildDb(env.DB);
  const [inv] = await db
    .select({ id: schema.invitation.id })
    .from(schema.invitation)
    .where(
      and(
        eq(schema.invitation.id, invitationId),
        eq(schema.invitation.organizationId, orgId),
        eq(schema.invitation.status, "pending"),
      ),
    )
    .limit(1);
  if (!inv) throw new InviteError(404, "Invitation not found.");

  await db
    .update(schema.invitation)
    .set({ status: "cancelled" })
    .where(eq(schema.invitation.id, invitationId));
  await db.insert(schema.auditEvents).values({
    orgId,
    actorUserId,
    action: "member.invite_revoked",
    targetType: "invitation",
    targetId: invitationId,
  });
}

const RESEND_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RESEND_MAX = 5; // per email per org per window (AC-16)

/**
 * Resend: cancel the current pending invitation and issue a fresh one, so the
 * old link stops working (AC-3). Rate limited per org+email (AC-16 → 429).
 */
export async function resendInvitation(opts: {
  env: AuthEnv;
  orgId: string;
  actorUserId: string;
  invitationId: string;
}): Promise<{ id: string }> {
  const { env, orgId, actorUserId, invitationId } = opts;
  const db = buildDb(env.DB);

  const [inv] = await db
    .select()
    .from(schema.invitation)
    .where(
      and(
        eq(schema.invitation.id, invitationId),
        eq(schema.invitation.organizationId, orgId),
        eq(schema.invitation.status, "pending"),
      ),
    )
    .limit(1);
  if (!inv) throw new InviteError(404, "Invitation not found.");

  // Rate limit: count invitations for this email in this org in the window.
  const since = new Date(Date.now() - RESEND_WINDOW_MS);
  const recent = await db
    .select({ id: schema.invitation.id })
    .from(schema.invitation)
    .where(
      and(
        eq(schema.invitation.organizationId, orgId),
        eq(schema.invitation.email, inv.email),
        gte(schema.invitation.createdAt, since),
      ),
    );
  if (recent.length >= RESEND_MAX) {
    throw new InviteError(429, "Too many resends for this address. Try again later.");
  }

  await db
    .update(schema.invitation)
    .set({ status: "cancelled" })
    .where(eq(schema.invitation.id, invitationId));

  const id = uuidv7();
  await db.insert(schema.invitation).values({
    id,
    organizationId: orgId,
    email: inv.email,
    role: inv.role,
    status: "pending",
    expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    inviterId: actorUserId,
    createdAt: new Date(),
  });
  await db.insert(schema.auditEvents).values({
    orgId,
    actorUserId,
    action: "member.invite_resent",
    targetType: "invitation",
    targetId: id,
    metadataJson: JSON.stringify({ email: inv.email, replaces: invitationId }),
  });

  const url = `${env.APP_URL}/accept-invitation/${id}`;
  await sendEmail(
    { apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM ?? "no-reply@americaworks.com" },
    {
      to: inv.email,
      subject: "Your invitation to AW File Storage",
      html: linkEmail("Your invitation was resent. Set a password to join:", url, "Accept invitation"),
    },
  );
  return { id };
}

export class InviteError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Accept an invitation: create the account for the invited email and add the
 * membership. Because global sign-up is disabled, account creation goes through
 * a sign-up-enabled Better Auth instance (same technique as the owner seed); the
 * invitation id is the unguessable capability that authorizes it.
 */
export async function acceptInvite(opts: {
  env: AuthEnv;
  invitationId: string;
  name: string;
  password: string;
}): Promise<{ email: string; orgId: string }> {
  const { env, invitationId, name, password } = opts;
  const db = buildDb(env.DB);

  const [inv] = await db
    .select()
    .from(schema.invitation)
    .where(
      and(eq(schema.invitation.id, invitationId), eq(schema.invitation.status, "pending")),
    )
    .limit(1);
  if (!inv) throw new Error("This invitation is invalid or has already been used.");
  if (new Date(inv.expiresAt).getTime() < Date.now()) {
    throw new Error("This invitation has expired.");
  }

  const signupAuth = betterAuth({
    ...authSharedOptions,
    emailAndPassword: {
      ...authSharedOptions.emailAndPassword,
      disableSignUp: false,
      requireEmailVerification: false,
    },
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.APP_URL,
    plugins: authPlugins,
  });

  await signupAuth.api.signUpEmail({ body: { email: inv.email, password, name } });
  // The invited email is verified by virtue of the invitation itself.
  await db
    .update(schema.user)
    .set({ emailVerified: true })
    .where(eq(schema.user.email, inv.email));

  const [u] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, inv.email))
    .limit(1);

  const memberId = uuidv7();
  await db.insert(schema.member).values({
    id: memberId,
    organizationId: inv.organizationId,
    userId: u.id,
    role: inv.role ?? "member",
    createdAt: new Date(),
  });
  await db
    .update(schema.invitation)
    .set({ status: "accepted" })
    .where(eq(schema.invitation.id, invitationId));

  // AC-12: the join is an access-control change and must be audited.
  await db.insert(schema.auditEvents).values({
    orgId: inv.organizationId,
    actorUserId: u.id,
    action: "member.joined",
    targetType: "member",
    targetId: memberId,
  });

  return { email: inv.email, orgId: inv.organizationId };
}
