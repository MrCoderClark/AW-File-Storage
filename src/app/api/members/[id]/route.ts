import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  changeMemberRole,
  getMemberDetail,
  MemberError,
  type OrgRole,
  removeMember,
  setMemberStatus,
  setMemberTwoFactorRequired,
} from "@/server/members";
import { requireApiRole } from "@/server/session";

const ROLES: OrgRole[] = ["owner", "admin", "member"];

// Full detail for one member (spec 0005 AC-10). Owner/admin only; org-scoped.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const { env } = getCloudflareContext();
  const detail = await getMemberDetail(env as unknown as { DB: D1Database }, {
    orgId: auth.actor.orgId,
    memberId: id,
  });
  if (!detail) return Response.json({ ok: false, error: "Member not found." }, { status: 404 });
  return Response.json({ ok: true, member: detail });
}

// Change a member's role (AC-4) and/or status (suspend/reactivate, AC-7/AC-8).
// Owner/admin only; guards enforced in the service (last active owner AC-5,
// self-action AC-6, org scope AC-14).
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const body = (await req.json().catch(() => ({}))) as {
    role?: string;
    status?: string;
    twoFactorRequired?: boolean;
  };
  if (
    body.role === undefined &&
    body.status === undefined &&
    body.twoFactorRequired === undefined
  ) {
    return Response.json(
      { ok: false, error: "Provide a change to apply." },
      { status: 400 },
    );
  }
  if (body.role !== undefined && !ROLES.includes(body.role as OrgRole)) {
    return Response.json(
      { ok: false, error: "A valid role is required." },
      { status: 400 },
    );
  }
  if (
    body.status !== undefined &&
    body.status !== "active" &&
    body.status !== "suspended"
  ) {
    return Response.json(
      { ok: false, error: "A valid status is required." },
      { status: 400 },
    );
  }

  const env = getCloudflareContext().env as unknown as { DB: D1Database };
  const base = {
    env,
    orgId: auth.actor.orgId,
    actorUserId: auth.actor.userId,
    memberId: id,
  };
  try {
    if (body.role !== undefined) {
      await changeMemberRole({ ...base, newRole: body.role as OrgRole });
    }
    if (body.status !== undefined) {
      await setMemberStatus({
        ...base,
        status: body.status as "active" | "suspended",
      });
    }
    if (body.twoFactorRequired !== undefined) {
      await setMemberTwoFactorRequired({
        ...base,
        required: Boolean(body.twoFactorRequired),
      });
    }
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof MemberError) {
      return Response.json({ ok: false, error: e.message }, { status: e.status });
    }
    throw e;
  }
}

// Remove a membership (spec 0005 AC-9). Deletes only the member row.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const { env } = getCloudflareContext();
  try {
    await removeMember({
      env: env as unknown as { DB: D1Database },
      orgId: auth.actor.orgId,
      actorUserId: auth.actor.userId,
      memberId: id,
    });
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof MemberError) {
      return Response.json({ ok: false, error: e.message }, { status: e.status });
    }
    throw e;
  }
}
