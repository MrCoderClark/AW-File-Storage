import { getCloudflareContext } from "@opennextjs/cloudflare";
import { type AuthEnv } from "@/server/auth";
import { acceptInvite } from "@/server/invitations";

// Accept an invitation by creating the account for the invited email. No session
// required — the unguessable invitation id is the capability that authorizes it.
// Password policy (12-char min + breach check) is enforced by the sign-up path.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    invitationId?: string;
    name?: string;
    password?: string;
  };
  if (!body.invitationId || !body.name || !body.password) {
    return new Response("Invalid input", { status: 400 });
  }

  const { env } = getCloudflareContext();
  try {
    const result = await acceptInvite({
      env: env as unknown as AuthEnv,
      invitationId: body.invitationId,
      name: body.name,
      password: body.password,
    });
    return Response.json({ ok: true, email: result.email });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : "error" },
      { status: 400 },
    );
  }
}
