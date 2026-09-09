import { getCloudflareContext } from "@opennextjs/cloudflare";
import { orgDbFor } from "@/server/org-db";
import { getActor } from "@/server/session";

// Reader feed for the Help drawer and /help page (spec 0024 AC-4): this org's published
// articles plus every org's shared published articles, filtered by the caller's role so a
// non-admin never receives `admins`-audience articles (spec 0025). Titles/excerpts only.
export const dynamic = "force-dynamic";

export async function GET() {
  const actor = await getActor();
  if (!actor) return new Response("Unauthorized", { status: 401 });

  const { env } = getCloudflareContext();
  const scoped = orgDbFor(actor.orgId, (env as unknown as { DB: D1Database }).DB);
  const articles = await scoped.help.listForReader({
    viewerIsAdmin: actor.canManageAny,
  });
  return Response.json({ ok: true, articles });
}
