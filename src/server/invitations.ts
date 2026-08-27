import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { and, eq } from "drizzle-orm";
import { authPlugins, authSharedOptions } from "./auth-options";
import { type AuthEnv } from "./auth";
import { buildDb } from "./db";
import * as schema from "./db/schema";
import { linkEmail, sendEmail } from "./email";
import { uuidv7 } from "./id";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (spec 0001 AC-10)

export type InviteRole = "admin" | "member";

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

  await db.insert(schema.member).values({
    id: uuidv7(),
    organizationId: inv.organizationId,
    userId: u.id,
    role: inv.role ?? "member",
    createdAt: new Date(),
  });
  await db
    .update(schema.invitation)
    .set({ status: "accepted" })
    .where(eq(schema.invitation.id, invitationId));

  return { email: inv.email, orgId: inv.organizationId };
}
