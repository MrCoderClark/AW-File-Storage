import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getActor } from "@/server/session";
import {
  DEFAULT_PAGE_SIZE,
  type FileSort,
  type ListFilesOpts,
  type SortDir,
  type UploadEnv,
  listFilesPage,
} from "@/server/uploads";

const SORTS: FileSort[] = ["new", "name", "size", "modified"];
const CATEGORIES = ["vcard", "pdf", "image", "document", "archive", "other"];
const STATUSES = ["pending", "uploading", "validating", "ready", "failed"];

// One keyset-paginated, filtered, sorted page of the org's live files. Query
// params: q, category, kind, status, sort, dir, cursor, limit (all optional).
export async function GET(req: Request) {
  const actor = await getActor();
  if (!actor) return new Response("Unauthorized", { status: 401 });

  const url = new URL(req.url);
  const p = url.searchParams;
  const sortRaw = p.get("sort") as FileSort | null;
  const dirRaw = p.get("dir");
  const categoryRaw = p.get("category");
  const kindRaw = p.get("kind");
  const statusRaw = p.get("status");
  const limitRaw = Number(p.get("limit"));

  const opts: ListFilesOpts = {
    q: p.get("q") ?? undefined,
    category: categoryRaw && CATEGORIES.includes(categoryRaw) ? categoryRaw : undefined,
    kind: kindRaw === "vcard" || kindRaw === "other" ? kindRaw : undefined,
    status:
      statusRaw && STATUSES.includes(statusRaw)
        ? (statusRaw as ListFilesOpts["status"])
        : undefined,
    sort: sortRaw && SORTS.includes(sortRaw) ? sortRaw : "new",
    dir: dirRaw === "asc" ? "asc" : ("desc" as SortDir),
    cursor: p.get("cursor") ?? undefined,
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_PAGE_SIZE,
  };

  const { env } = getCloudflareContext();
  const { items, nextCursor } = await listFilesPage(
    env as unknown as UploadEnv,
    actor,
    opts,
  );
  return Response.json({ ok: true, items, nextCursor });
}
