import { describe, expect, it } from "vitest";
import { sanitizeHelpHtml } from "../src/server/help-sanitize";
import {
  type ContextArticle,
  markdownToHtml,
  parseDraftResponse,
  selectContextArticles,
} from "../src/server/help-ai";

// The pure pieces of the AI drafting pipeline (spec 0027). The live Workers AI call is verified
// manually (0027-verify.md); everything deterministic is unit-tested here.

const ARTICLES: ContextArticle[] = [
  { id: "a", title: "Publishing a contact card", excerpt: "How to publish", searchText: "publish vcard card qr signature" },
  { id: "b", title: "Uploading files", excerpt: "Upload center", searchText: "upload files r2 storage" },
  { id: "c", title: "Office 365 sync", excerpt: "Graph", searchText: "office 365 microsoft directory attribute" },
];

describe("selectContextArticles", () => {
  it("ranks by topic word overlap and drops non-matches", () => {
    const picked = selectContextArticles("how do I publish a card", ARTICLES);
    expect(picked[0]?.id).toBe("a"); // "publish" + "card" match
    expect(picked.map((p) => p.id)).not.toContain("c");
  });

  it("respects the max count", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      id: `x${i}`,
      title: "upload files guide",
      searchText: "upload files",
    }));
    expect(selectContextArticles("upload files", many, 4)).toHaveLength(4);
  });

  it("falls back to the first few when the topic has no usable words", () => {
    expect(selectContextArticles("a", ARTICLES).length).toBeGreaterThan(0);
  });
});

describe("markdownToHtml + sanitize", () => {
  it("converts headings, lists, bold, code, and links", () => {
    const html = markdownToHtml(
      "## Steps\n\n1. Open **Create Card**\n2. Click `Publish`\n\n- see [help](/help)",
    );
    expect(html).toContain("<h2>Steps</h2>");
    expect(html).toContain("<ol><li>");
    expect(html).toContain("<strong>Create Card</strong>");
    expect(html).toContain("<code>Publish</code>");
    expect(html).toContain('<a href="/help">help</a>');
  });

  it("converts fenced code blocks", () => {
    const html = markdownToHtml("```\ndocker compose up\n```");
    expect(html).toContain("<pre><code>docker compose up</code></pre>");
  });

  it("strips anything unsafe once sanitized (defense in depth)", () => {
    const dirty = markdownToHtml("Hello\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))");
    const safe = sanitizeHelpHtml(dirty);
    // Raw HTML from the model is escaped to inert text (no live tag), and bad link schemes are dropped.
    expect(safe).not.toContain("<script");
    expect(safe).not.toMatch(/javascript:/i);
  });

  it("neutralises a non-http link scheme during conversion", () => {
    // The inline converter rewrites a disallowed scheme to "#".
    expect(markdownToHtml("[x](javascript:alert(1))")).toContain('href="#"');
  });
});

describe("parseDraftResponse", () => {
  it("parses the labeled TITLE/EXCERPT/BODY format (quotes and newlines in body are harmless)", () => {
    const raw =
      'TITLE: Publishing a Card\nEXCERPT: How to publish.\nBODY:\n# Publishing a Card\n\nClick the "Browse files" button.\n\n1. Open **Upload Center**';
    const r = parseDraftResponse(raw, "topic");
    expect(r.title).toBe("Publishing a Card");
    expect(r.excerpt).toBe("How to publish.");
    expect(r.bodyMarkdown).toContain('Click the "Browse files" button.');
    expect(r.bodyMarkdown).not.toContain("TITLE:");
    expect(r.bodyMarkdown).not.toContain("BODY:");
  });

  it("parses a clean JSON object", () => {
    const r = parseDraftResponse(
      '{"title":"T","excerpt":"E","body":"## Body"}',
      "topic",
    );
    expect(r).toEqual({ title: "T", excerpt: "E", bodyMarkdown: "## Body" });
  });

  it("extracts JSON embedded in surrounding prose", () => {
    const r = parseDraftResponse(
      'Sure! Here is your article:\n{"title":"T","excerpt":"E","body":"B"}\nHope that helps.',
      "topic",
    );
    expect(r.title).toBe("T");
    expect(r.bodyMarkdown).toBe("B");
  });

  it("falls back to the whole response as body when there is no JSON", () => {
    const r = parseDraftResponse("## Just markdown\n\nno json here", "My Topic");
    expect(r.title).toBe("My Topic");
    expect(r.bodyMarkdown).toContain("Just markdown");
  });

  it("recovers fields from JSON-shaped output with literal newlines and unescaped quotes in body", () => {
    // The real Llama failure: body has raw newlines AND unescaped inner quotes (button names),
    // both invalid JSON — must not dump the {…} wrapper into the article.
    const raw =
      '{"title": "Publishing a Card", "excerpt": "How to publish.", "body": "# Publishing a Card\n\nClick the "Browse files" button.\n\n1. Open **Upload Center**"}';
    const r = parseDraftResponse(raw, "topic");
    expect(r.title).toBe("Publishing a Card");
    expect(r.excerpt).toBe("How to publish.");
    expect(r.bodyMarkdown).toContain("# Publishing a Card");
    expect(r.bodyMarkdown).toContain('"Browse files"');
    expect(r.bodyMarkdown).not.toContain('"body"'); // the JSON key must not leak in
    expect(r.bodyMarkdown).not.toContain('"title"');
  });
});
