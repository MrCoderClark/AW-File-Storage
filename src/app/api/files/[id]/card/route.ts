import { getCloudflareContext } from "@opennextjs/cloudflare";
import { type O365SyncEnv, triggerO365Sync } from "@/server/o365-sync";
import { getActor } from "@/server/session";
import { editVcard, type UploadEnv, UploadError } from "@/server/uploads";

// Edit a published contact card in place (spec 0006 follow-up). JSON body:
// `{ vcard, name? }` where `vcard` is the rebuilt vCard 3.0 text. Re-publishes
// under the same slug; canManage is re-checked in editVcard.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActor();
  if (!actor) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;

  const body = (await req.json().catch(() => ({}))) as {
    vcard?: string;
    name?: string;
  };
  if (!body.vcard?.trim()) {
    return Response.json(
      { ok: false, error: "A contact card is required." },
      { status: 400 },
    );
  }

  const { env } = getCloudflareContext();
  try {
    const { publicUrl } = await editVcard(
      env as unknown as UploadEnv,
      actor,
      id,
      body.vcard,
      body.name,
    );
    // Re-sync to Office 365: the URL is unchanged, but the email (and so the
    // matched mailbox) may have (spec 0010). Best effort, off unless configured.
    triggerO365Sync(env as unknown as O365SyncEnv, id);
    return Response.json({ ok: true, publicUrl });
  } catch (e) {
    if (e instanceof UploadError) {
      return Response.json({ ok: false, error: e.message }, { status: e.status });
    }
    throw e;
  }
}
