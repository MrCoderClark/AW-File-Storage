import { getCloudflareContext } from "@opennextjs/cloudflare";
import { type AuthEnv } from "@/server/auth";
import { acceptInvite, previewInvite } from "@/server/invitations";
import { acceptProvision } from "@/server/provisioning";

// Accept an invitation OR a platform-owner provision (spec 0005 / 0014) by creating
// the account for the invited email. No session required — the unguessable id is the
// capability that authorizes it. The same id space serves both: if it's a known
// invitation we accept that (one org); otherwise we treat it as a provision (N orgs).
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

  const env = getCloudflareContext().env as unknown as AuthEnv;
  const id = body.invitationId;
  try {
    // Is the id an invitation? (valid/expired/used → yes; invalid → try provision)
    const invite = await previewInvite(env, id);
    const result =
      invite.status !== "invalid"
        ? await acceptInvite({ env, invitationId: id, name: body.name, password: body.password })
        : await acceptProvision({ env, provisionId: id, name: body.name, password: body.password });
    return Response.json({ ok: true, email: result.email });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : "error" },
      { status: 400 },
    );
  }
}
