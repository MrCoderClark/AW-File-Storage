import { getCloudflareContext } from "@opennextjs/cloudflare";
import { type AuthEnv } from "@/server/auth";
import { requirePlatformOwner } from "@/server/platform";
import {
  type Assignment,
  createProvision,
  listAllOrgs,
  ProvisionError,
} from "@/server/provisioning";

// Provisioning console API (spec 0014). Platform-owner only.
//  GET  → every organization (for the picker).
//  POST → provision a user (create a multi-org invite + email the accept link).
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requirePlatformOwner();
  if (!guard.ok) return guard.response;
  const env = getCloudflareContext().env as unknown as AuthEnv;
  return Response.json({ ok: true, orgs: await listAllOrgs(env) });
}

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
    const { id } = await createProvision({
      env,
      email: body.email,
      assignments: body.assignments,
      createdBy: guard.actorUserId,
    });
    return Response.json({ ok: true, id });
  } catch (e) {
    const status = e instanceof ProvisionError ? e.status : 400;
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : "error" },
      { status },
    );
  }
}
