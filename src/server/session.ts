import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "./auth";

/**
 * The ONLY way feature code learns who the caller is (spec 0001 cross-child
 * contract). Wraps Better Auth's server-side session read. Returns the session
 * + user, or null when there is no valid session.
 */
export async function getSession() {
  const auth = getAuth();
  return auth.api.getSession({ headers: await headers() });
}

/** Require a signed-in caller; redirect to sign-in otherwise. Returns the session. */
export async function requireSession() {
  const session = await getSession();
  if (!session) redirect("/sign-in");
  return session;
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
    // A caller lacking the role is treated as not-found rather than told what exists.
    throw new Error("Forbidden");
  }
  return { session, role: actual };
}
