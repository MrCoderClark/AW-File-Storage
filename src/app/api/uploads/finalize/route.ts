import { getCloudflareContext } from "@opennextjs/cloudflare";
import { type O365SyncEnv, triggerO365Sync } from "@/server/o365-sync";
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
    // Push the new card's URL into Office 365 (spec 0010); best effort, off unless configured.
    if (result.visibility === "public") {
      triggerO365Sync(env as unknown as O365SyncEnv, result.fileId);
    }
    return Response.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof UploadError) {
      return Response.json({ ok: false, error: e.message }, { status: e.status });
    }
    throw e;
  }
}
