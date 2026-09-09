import { getCloudflareContext } from "@opennextjs/cloudflare";
import { orgDbFor } from "@/server/org-db";
import { getActor } from "@/server/session";

// Count a view of a help article (spec 0026 polish). Any signed-in reader; org-scoped, so only
// the owning org's views of a shared article are counted. Fire-and-forget from the reader page.
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActor();
  if (!actor) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  const { env } = getCloudflareContext();
  const scoped = orgDbFor(actor.orgId, (env as unknown as { DB: D1Database }).DB);
  await scoped.help.incrementView(id);
  return Response.json({ ok: true });
}
