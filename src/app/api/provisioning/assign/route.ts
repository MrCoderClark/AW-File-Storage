import { getCloudflareContext } from "@opennextjs/cloudflare";
import { type AuthEnv } from "@/server/auth";
import { requirePlatformOwner } from "@/server/platform";
import {
  type Assignment,
  assignExistingUser,
  ProvisionError,
} from "@/server/provisioning";

// Assign an EXISTING account to org(s) directly — no email/accept (spec 0014).
// Platform-owner only.
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guard = await requirePlatformOwner();
  if (!guard.ok) return guard.response;
  const body = (await req.json().catch(() => ({}))) as {
    email?: string;
    assignments?: Assignment[];
  };
  if (!body.email || !Array.isArray(body.assignments)) {
    return Response.json(
      { ok: false, error: "An email and at least one organization are required." },
      { status: 400 },
    );
  }
  const env = getCloudflareContext().env as unknown as AuthEnv;
  try {
    const { added } = await assignExistingUser({
      env,
      email: body.email,
      assignments: body.assignments,
      actorUserId: guard.actorUserId,
    });
    return Response.json({ ok: true, added });
  } catch (e) {
    const status = e instanceof ProvisionError ? e.status : 400;
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : "error" },
      { status },
    );
  }
}
