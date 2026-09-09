// Small pure helpers for the help CMS (spec 0024), shared by the article routes.

/** The help image ids embedded in a body (src="/api/help/images/<id>"). */
export function imageIdsIn(html: string): string[] {
  const ids = new Set<string>();
  const re = /\/api\/help\/images\/([A-Za-z0-9_-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) ids.add(m[1]);
  return [...ids];
}

/** A url-safe slug from a title (cosmetic; reader routes by id). */
export function helpSlugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "article"
  );
}
