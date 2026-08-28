import { getCloudflareContext } from "@opennextjs/cloudflare";
import { type AuthEnv } from "@/server/auth";
import {
  createInvite,
  type InviteRole,
  listInvitations,
} from "@/server/invitations";
import { requireApiRole } from "@/server/session";

// Pending invitations for the active org (spec 0005 AC-3, AC-15). Owner/admin.
export async function GET(req: Request) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;

  const { env } = getCloudflareContext();
  const result = await listInvitations(env as unknown as AuthEnv, {
    orgId: auth.actor.orgId,
    cursor,
    limit: Number.isFinite(limit) ? limit : undefined,
  });
  return Response.json({ ok: true, ...result });
}

// Create + email an invitation. Owner/admin only.
export async function POST(req: Request) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => ({}))) as {
    email?: string;
    role?: InviteRole;
  };
  if (!body.email || (body.role !== "admin" && body.role !== "member")) {
    return Response.json(
      { ok: false, error: "A valid email and role are required." },
      { status: 400 },
    );
  }

  const { env } = getCloudflareContext();
  try {
    const inv = await createInvite({
      env: env as unknown as AuthEnv,
      orgId: auth.actor.orgId,
      inviterId: auth.actor.userId,
      email: body.email,
      role: body.role,
    });
    // The link is emailed; only expose it in the response outside production.
    const url = process.env.NODE_ENV === "production" ? undefined : inv.url;
    return Response.json({ ok: true, invitationId: inv.id, url });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : "Could not invite." },
      { status: 409 },
    );
  }
}
