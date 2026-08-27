import { getCloudflareContext } from "@opennextjs/cloudflare";
import { headers } from "next/headers";
import { type AuthEnv, getAuth } from "@/server/auth";
import { createInvite, type InviteRole } from "@/server/invitations";
import { getSession } from "@/server/session";

// Create + email an invitation. Owner/admin only (spec 0002 role matrix).
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const auth = getAuth();
  const member = await auth.api.getActiveMember({ headers: await headers() });
  if (member?.role !== "owner" && member?.role !== "admin") {
    return new Response("Forbidden", { status: 403 });
  }

  const orgId = (session.session as { activeOrganizationId?: string | null })
    .activeOrganizationId;
  if (!orgId) return new Response("No active organization", { status: 400 });

  const body = (await req.json().catch(() => ({}))) as {
    email?: string;
    role?: InviteRole;
  };
  if (!body.email || (body.role !== "admin" && body.role !== "member")) {
    return new Response("Invalid input", { status: 400 });
  }

  const { env } = getCloudflareContext();
  try {
    const inv = await createInvite({
      env: env as unknown as AuthEnv,
      orgId,
      inviterId: session.user.id,
      email: body.email,
      role: body.role,
    });
    // The link is emailed; only expose it in the response outside production.
    const url = process.env.NODE_ENV === "production" ? undefined : inv.url;
    return Response.json({ ok: true, invitationId: inv.id, url });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : "error" },
      { status: 409 },
    );
  }
}
