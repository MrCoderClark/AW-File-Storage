import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getActor } from "@/server/session";
import { type UploadEnv, listFiles } from "@/server/uploads";

// List the org's live files (feeds the Upload Center in Phase 4).
export async function GET() {
  const actor = await getActor();
  if (!actor) return new Response("Unauthorized", { status: 401 });
  const { env } = getCloudflareContext();
  const files = await listFiles(env as unknown as UploadEnv, actor);
  return Response.json({ ok: true, files });
}
