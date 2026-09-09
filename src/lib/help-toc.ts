// Build an "On this page" table of contents from already-sanitized help HTML (spec 0026 polish).
// Runs on the server after sanitizeHelpHtml, so the input is trusted: headings carry no
// attributes (the sanitizer whitelist gives h2/h3 none), and the ids we inject are our own
// slugified text (letters, digits, dashes) — no user value reaches an attribute.

export interface TocItem {
  id: string;
  text: string;
  level: 2 | 3;
}

export function buildHelpToc(html: string): { html: string; toc: TocItem[] } {
  const toc: TocItem[] = [];
  const used = new Map<string, number>();

  const slugify = (text: string): string => {
    const base =
      text
        .toLowerCase()
        .replace(/&[a-z]+;/g, " ")
        .replace(/[^a-z0-9\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-")
        .slice(0, 60) || "section";
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen}`;
  };

  const withIds = html.replace(
    /<h([23])>([\s\S]*?)<\/h\1>/g,
    (_match, lvl: string, inner: string) => {
      const level = Number(lvl) as 2 | 3;
      const text = inner.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (!text) return `<h${lvl}>${inner}</h${lvl}>`;
      const id = slugify(text);
      toc.push({ id, text, level });
      return `<h${lvl} id="${id}">${inner}</h${lvl}>`;
    },
  );

  return { html: withIds, toc };
}
