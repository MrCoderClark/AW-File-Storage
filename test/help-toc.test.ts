import { describe, expect, it } from "vitest";
import { buildHelpToc } from "../src/lib/help-toc";

// The article TOC builder (spec 0026 polish): extract h2/h3 into a list and inject matching ids
// into the HTML. Runs on already-sanitized HTML, so headings carry no attributes.

describe("buildHelpToc", () => {
  it("extracts h2/h3 with levels and injects matching ids", () => {
    const { html, toc } = buildHelpToc(
      "<h2>Getting started</h2><p>x</p><h3>Step one</h3><h2>Wrap up</h2>",
    );
    expect(toc).toEqual([
      { id: "getting-started", text: "Getting started", level: 2 },
      { id: "step-one", text: "Step one", level: 3 },
      { id: "wrap-up", text: "Wrap up", level: 2 },
    ]);
    expect(html).toContain('<h2 id="getting-started">Getting started</h2>');
    expect(html).toContain('<h3 id="step-one">Step one</h3>');
  });

  it("de-duplicates repeated heading slugs", () => {
    const { toc } = buildHelpToc("<h2>Notes</h2><h2>Notes</h2>");
    expect(toc.map((t) => t.id)).toEqual(["notes", "notes-1"]);
  });

  it("uses the text content when a heading has inline formatting", () => {
    const { toc } = buildHelpToc("<h2><strong>Bold</strong> title</h2>");
    expect(toc[0]).toEqual({ id: "bold-title", text: "Bold title", level: 2 });
  });

  it("leaves an empty heading untouched and out of the toc", () => {
    const { html, toc } = buildHelpToc("<h2></h2><p>body</p>");
    expect(toc).toHaveLength(0);
    expect(html).toContain("<h2></h2>");
  });
});
