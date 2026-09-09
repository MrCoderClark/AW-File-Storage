import { getCloudflareContext } from "@opennextjs/cloudflare";
import { helpSlugify } from "@/lib/help-format";
import { orgDbFor } from "@/server/org-db";
import { requireApiRole } from "@/server/session";

// Help knowledge-base categories (spec 0025). Owner/admin, org-scoped. GET lists this org's
// categories; POST creates one (optionally nested under a parent).
export const dynamic = "force-dynamic";

interface Env {
  DB: D1Database;
}

export async function GET() {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { env } = getCloudflareContext();
  const scoped = orgDbFor(auth.actor.orgId, (env as unknown as Env).DB);
  const categories = await scoped.help.listCategories();
  return Response.json({ ok: true, categories });
}

export async function POST(req: Request) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    slug?: string;
    parentId?: string;
    sortOrder?: number;
  };
  const name = body.name?.trim();
  if (!name) {
    return Response.json({ ok: false, error: "A name is required." }, { status: 400 });
  }

  const { env } = getCloudflareContext();
  const scoped = orgDbFor(auth.actor.orgId, (env as unknown as Env).DB);
  const category = await scoped.help.createCategory({
    name,
    slug: body.slug?.trim() || helpSlugify(name),
    parentId: body.parentId?.trim() || null,
    sortOrder: body.sortOrder ?? 0,
  });
  return Response.json({ ok: true, id: category.id });
}
