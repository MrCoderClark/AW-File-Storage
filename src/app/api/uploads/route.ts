import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getSession } from "@/server/session";
import { type UploadEnv, UploadError, requestUpload } from "@/server/uploads";

// Reserve an upload and get a presigned PUT (spec 0003). Any signed-in member.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  const orgId = (session.session as { activeOrganizationId?: string | null })
    .activeOrganizationId;
  if (!orgId) return new Response("No active organization", { status: 400 });

  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    size?: number;
    contentType?: string;
  };
  if (!body.name || typeof body.size !== "number" || !body.contentType) {
    return new Response("Invalid input", { status: 400 });
  }

  const { env } = getCloudflareContext();
  try {
    const result = await requestUpload(
      env as unknown as UploadEnv,
      { orgId, userId: session.user.id },
      { name: body.name, size: body.size, contentType: body.contentType },
    );
    return Response.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof UploadError) {
      return Response.json(
        { ok: false, error: e.message },
        {
          status: e.status,
          headers: e.retryAfterSeconds
            ? { "Retry-After": String(e.retryAfterSeconds) }
            : undefined,
        },
      );
    }
    throw e;
  }
}
