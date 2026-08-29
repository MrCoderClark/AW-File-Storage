import { FilesView } from "@/components/files-view";

// Reads the ?q= search seed per request.
export const dynamic = "force-dynamic";

export default async function FilesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  return <FilesView initialQuery={q ?? ""} />;
}
