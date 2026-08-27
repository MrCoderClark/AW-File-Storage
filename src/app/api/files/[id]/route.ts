import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getActor } from "@/server/session";
import { type UploadEnv, UploadError, deleteFile } from "@/server/uploads";

// Soft-delete a file (and remove its public object if published).
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActor();
  if (!actor) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;

  const { env } = getCloudflareContext();
  try {
    await deleteFile(env as unknown as UploadEnv, actor, id);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof UploadError) {
      return Response.json({ ok: false, error: e.message }, { status: e.status });
    }
    throw e;
  }
}
