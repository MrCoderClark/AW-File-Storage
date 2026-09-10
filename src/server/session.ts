import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getAuth } from "./auth";
import { getDb } from "./db";
import { member, organization } from "./db/auth-schema";

const ABSOLUTE_SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (spec 0001 AC-5)

/**
 * The ONLY way feature code learns who the caller is (spec 0001 cross-child
 * contract). Wraps Better Auth's server-side session read. Returns the session
 * + user, or null when there is no valid session.
 *
 * Better Auth's `expiresIn` gives an 8h rolling idle ceiling; on top of that we
 * enforce a hard 7-day cap from creation (AC-5): a session older than that is
 * rejected here even though its row still exists (the nightly cleanup removes
 * the row later).
 */
export async function getSession() {
  const auth = getAuth();
  const result = await auth.api.getSession({ headers: await headers() });
  if (!result) return null;

  const createdAt = new Date(result.session.createdAt).getTime();
  if (Number.isFinite(createdAt) && Date.now() - createdAt > ABSOLUTE_SESSION_MAX_MS) {
    return null;
  }
  return result;
}

/**
 * The display name of an organization by id (identity table, not tenant data), or
 * null if unknown. Used where an email or message needs the org's human name rather
 * than its opaque id (e.g. the support-request email).
 */
export async function getOrgName(orgId: string): Promise<string | null> {
  const [org] = await getDb()
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1);
  return org?.name ?? null;
}

/** Require a signed-in caller; redirect to sign-in otherwise. Returns the session. */
export async function requireSession() {
  const session = await getSession();
  if (!session) redirect("/sign-in");
  return session;
}

/**
 * Resolve the acting caller for file operations: their org, user id, and whether
 * their role (owner/admin) lets them manage any file vs only their own. Returns
 * null when there is no usable session/org.
 */
export async function getActor(): Promise<
  { orgId: string; userId: string; role: Role; canManageAny: boolean } | null
> {
  const session = await getSession();
  if (!session) return null;
  const orgId = (session.session as { activeOrganizationId?: string | null })
    .activeOrganizationId;
  if (!orgId) return null;
  const auth = getAuth();
  const member = await auth.api.getActiveMember({ headers: await headers() });
  const role = (member?.role as Role | undefined) ?? "member";
  return {
    orgId,
    userId: session.user.id,
    role,
    canManageAny: role === "owner" || role === "admin",
  };
}

/**
 * Whether the caller's active-org membership requires a second factor (admin
 * set), regardless of whether they've enrolled. Used to hide the self-service
 * "disable" control (spec 0001 AC-11).
 */
export async function activeMembershipTwoFactorRequired(): Promise<boolean> {
  const session = await getSession();
  if (!session) return false;
  const orgId = (session.session as { activeOrganizationId?: string | null })
    .activeOrganizationId;
  if (!orgId) return false;
  const [m] = await getDb()
    .select({ required: member.twoFactorRequired })
    .from(member)
    .where(
      and(eq(member.userId, session.user.id), eq(member.organizationId, orgId)),
    )
    .limit(1);
  return Boolean(m?.required);
}

/**
 * True when the caller's active-org membership requires a second factor but they
 * have not enrolled one yet (spec 0001 AC-11). The app layout uses this to force
 * enrolment before any app route renders.
 */
export async function twoFactorEnrollmentRequired(): Promise<boolean> {
  const session = await getSession();
  const enrolled = Boolean(
    (session?.user as { twoFactorEnabled?: boolean } | undefined)
      ?.twoFactorEnabled,
  );
  if (!session || enrolled) return false;
  return activeMembershipTwoFactorRequired();
}

export type Role = "owner" | "admin" | "member";

const RANK: Record<Role, number> = { member: 1, admin: 2, owner: 3 };

/**
 * Require a signed-in caller whose role in their active organization is at
 * least `role`. The role is read from Better Auth's membership, never from the
 * request. (Second-factor enforcement for privileged roles is layered on in a
 * later sub-step, per spec 0001 AC-11.)
 */
export async function requireOrgRole(role: Role) {
  const session = await requireSession();
  const auth = getAuth();
  // activeOrganizationId is set by the organization plugin at runtime but not
  // surfaced on Better Auth's inferred session type.
  const orgId = (session.session as { activeOrganizationId?: string | null })
    .activeOrganizationId;
  if (!orgId) redirect("/sign-in");

  const member = await auth.api.getActiveMember({ headers: await headers() });
  const actual = member?.role as Role | undefined;
  if (!actual || RANK[actual] < RANK[role]) {
    // A caller lacking the role is treated as not-found rather than told what
    // exists (renders the 404 page, not a 500).
    notFound();
  }

  // 2FA is NOT forced on owners/admins as a blanket rule (revised from spec 0001
  // AC-11 by owner request). Enrolment is only mandated per-member via
  // `member.twoFactorRequired`, enforced in the (app) layout
  // (`twoFactorEnrollmentRequired`). Everyone may still enable it voluntarily.
  return { session, role: actual };
}

export interface ApiActor {
  orgId: string;
  userId: string;
  role: Role;
}

export type ApiRoleResult =
  | { ok: true; actor: ApiActor }
  | { ok: false; response: Response };

function apiError(status: number, error: string): Response {
  return Response.json({ ok: false, error }, { status });
}

/**
 * Route-handler counterpart to requireOrgRole (spec 0005). Returns a typed
 * result instead of redirecting or throwing, so an endpoint can emit a real
 * 401/403 JSON response rather than the 500 a thrown Error produced. Role gating
 * only — the second-factor enrolment gate stays on the page-level requireOrgRole,
 * which every admin surface in this feature sits behind.
 *
 * Usage:
 *   const auth = await requireApiRole("admin");
 *   if (!auth.ok) return auth.response;
 *   // auth.actor.{orgId,userId,role}
 */
export async function requireApiRole(minRole: Role): Promise<ApiRoleResult> {
  const session = await getSession();
  if (!session) return { ok: false, response: apiError(401, "Not signed in.") };
  const orgId = (session.session as { activeOrganizationId?: string | null })
    .activeOrganizationId;
  if (!orgId) {
    return { ok: false, response: apiError(401, "No active organization.") };
  }
  const member = await getAuth().api.getActiveMember({
    headers: await headers(),
  });
  const role = member?.role as Role | undefined;
  if (!role || RANK[role] < RANK[minRole]) {
    return {
      ok: false,
      response: apiError(403, "You do not have permission to do this."),
    };
  }
  return { ok: true, actor: { orgId, userId: session.user.id, role } };
}
