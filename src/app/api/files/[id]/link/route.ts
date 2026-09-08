import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getActor } from "@/server/session";
import { type UploadEnv, UploadError, createPrivateLink } from "@/server/uploads";

// Issue a short-lived signed download URL for a private file.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActor();
  if (!actor) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;

  const { env } = getCloudflareContext();
  try {
    const result = await createPrivateLink(env as unknown as UploadEnv, actor, id);
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
