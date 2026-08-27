import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getActor } from "@/server/session";
import { type UploadEnv, UploadError, unpublishVcard } from "@/server/uploads";

// Unpublish a vCard: the public address stops resolving; the private copy stays.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActor();
  if (!actor) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;

  const { env } = getCloudflareContext();
  try {
    await unpublishVcard(env as unknown as UploadEnv, actor, id);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof UploadError) {
      return Response.json({ ok: false, error: e.message }, { status: e.status });
    }
    throw e;
  }
}
