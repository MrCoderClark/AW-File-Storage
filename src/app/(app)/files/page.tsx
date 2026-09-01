import { getCloudflareContext } from "@opennextjs/cloudflare";
import { FilesView, type SerializedFile } from "@/components/files-view";
import type { FileCategory } from "@/lib/file-type";
import { getActor } from "@/server/session";
import {
  type FileSort,
  type SortDir,
  type UploadEnv,
  listFilesPage,
} from "@/server/uploads";

// Reads the filter/sort seed from the query string per request.
export const dynamic = "force-dynamic";

const SORTS: FileSort[] = ["new", "name", "size", "modified"];
const CATEGORIES: FileCategory[] = [
  "vcard",
  "pdf",
  "image",
  "document",
  "archive",
  "other",
];

export default async function FilesPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    category?: string;
    sort?: string;
    dir?: string;
  }>;
}) {
  const { q, category: categoryRaw, sort: sortRaw, dir: dirRaw } = await searchParams;
  const sort: FileSort =
    sortRaw && SORTS.includes(sortRaw as FileSort) ? (sortRaw as FileSort) : "new";
  const dir: SortDir = dirRaw === "asc" ? "asc" : "desc";
  const category =
    categoryRaw && CATEGORIES.includes(categoryRaw as FileCategory)
      ? (categoryRaw as FileCategory)
      : undefined;

  const actor = await getActor();
  if (!actor) {
    // The (app) layout gates auth; this is a defensive fallback.
    return <FilesView initialItems={[]} initialCursor={null} />;
  }

  const { env } = getCloudflareContext();
  const { items, nextCursor } = await listFilesPage(
    env as unknown as UploadEnv,
    actor,
    { q, category, sort, dir },
  );

  const initial: SerializedFile[] = items.map((f) => ({
    ...f,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
  }));

  return (
    <FilesView
      initialItems={initial}
      initialCursor={nextCursor}
      initialQuery={q ?? ""}
      initialCategory={category ?? "all"}
      initialSort={sort}
      initialDir={dir}
    />
  );
}
