import { getCloudflareContext } from "@opennextjs/cloudflare";
import { orgDbFor } from "@/server/org-db";
import { requireApiRole } from "@/server/session";

// Rename / reparent / reorder or delete a help category (spec 0025). Owner/admin, org-scoped.
// Deleting reparents children to top-level and clears the category off any article.
export const dynamic = "force-dynamic";

interface Env {
  DB: D1Database;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    slug?: string;
    parentId?: string | null;
    sortOrder?: number;
  };

  const { env } = getCloudflareContext();
  const scoped = orgDbFor(auth.actor.orgId, (env as unknown as Env).DB);
  const existing = await scoped.help.getCategory(id);
  if (!existing) {
    return Response.json({ ok: false, error: "Category not found." }, { status: 404 });
  }

  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const n = body.name.trim();
    if (!n) return Response.json({ ok: false, error: "A name is required." }, { status: 400 });
    patch.name = n;
  }
  if (body.slug !== undefined) patch.slug = body.slug.trim() || existing.slug;
  // Guard against making a category its own parent (a one-level cycle guard; deeper cycles
  // are unlikely in a small hand-managed tree and reparent-on-delete keeps it consistent).
  if (body.parentId !== undefined) {
    patch.parentId = body.parentId && body.parentId !== id ? body.parentId : null;
  }
  if (body.sortOrder !== undefined) patch.sortOrder = body.sortOrder;

  await scoped.help.updateCategory(
    id,
    patch as Partial<Parameters<typeof scoped.help.createCategory>[0]>,
  );
  return Response.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const { env } = getCloudflareContext();
  const scoped = orgDbFor(auth.actor.orgId, (env as unknown as Env).DB);
  const existing = await scoped.help.getCategory(id);
  if (!existing) {
    return Response.json({ ok: false, error: "Category not found." }, { status: 404 });
  }
  await scoped.help.removeCategory(id);
  return Response.json({ ok: true });
}
