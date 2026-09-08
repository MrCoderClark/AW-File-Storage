import { getCloudflareContext } from "@opennextjs/cloudflare";
import { orgDbFor } from "@/server/org-db";
import { getSession } from "@/server/session";

// Reader feed for the Help drawer and /help page (spec 0024 AC-4): this org's published
// articles plus every org's shared published articles. Any signed-in member. Titles/excerpts
// only — the full body is loaded on the article page.
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  const orgId = (session.session as { activeOrganizationId?: string | null })
    .activeOrganizationId;
  if (!orgId) return new Response("No active organization", { status: 400 });

  const { env } = getCloudflareContext();
  const scoped = orgDbFor(orgId, (env as unknown as { DB: D1Database }).DB);
  const articles = await scoped.help.listForReader();
  return Response.json({ ok: true, articles });
}
