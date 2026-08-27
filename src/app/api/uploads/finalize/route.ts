import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getSession } from "@/server/session";
import { type UploadEnv, UploadError, finalizeUpload } from "@/server/uploads";

// Confirm the uploaded bytes and mark the file ready (spec 0003).
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  const orgId = (session.session as { activeOrganizationId?: string | null })
    .activeOrganizationId;
  if (!orgId) return new Response("No active organization", { status: 400 });

  const body = (await req.json().catch(() => ({}))) as {
    uploadSessionId?: string;
  };
  if (!body.uploadSessionId) return new Response("Invalid input", { status: 400 });

  const { env } = getCloudflareContext();
  try {
    const result = await finalizeUpload(
      env as unknown as UploadEnv,
      { orgId },
      body.uploadSessionId,
    );
    return Response.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof UploadError) {
      return Response.json({ ok: false, error: e.message }, { status: e.status });
    }
    throw e;
  }
}
