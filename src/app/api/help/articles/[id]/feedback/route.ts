import { getCloudflareContext } from "@opennextjs/cloudflare";
import { orgDbFor } from "@/server/org-db";
import { getActor } from "@/server/session";

// Record a "was this helpful?" vote on a help article (spec 0026 polish). Any signed-in reader;
// org-scoped. Double-voting is guarded per-browser on the client; this endpoint just increments.
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActor();
  if (!actor) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;

  const body = (await req.json().catch(() => ({}))) as { helpful?: boolean };
  if (typeof body.helpful !== "boolean") {
    return Response.json({ ok: false, error: "Bad request." }, { status: 400 });
  }

  const { env } = getCloudflareContext();
  const scoped = orgDbFor(actor.orgId, (env as unknown as { DB: D1Database }).DB);
  await scoped.help.recordFeedback(id, body.helpful);
  return Response.json({ ok: true });
}
