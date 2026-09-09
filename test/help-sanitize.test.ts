import { describe, expect, it } from "vitest";
import { sanitizeHelpHtml } from "../src/server/help-sanitize";

// The sanitizer is the backstop against stored XSS from admin-authored help HTML (spec 0024
// AC-8), which matters because the app CSP allows inline script (spec 0020).

describe("sanitizeHelpHtml (spec 0024 AC-8)", () => {
  it("strips <script> and inline event handlers", () => {
    const out = sanitizeHelpHtml(
      '<p onclick="steal()">hi</p><script>alert(1)</script>',
    );
    expect(out).not.toMatch(/script/i);
    expect(out).not.toMatch(/onclick/i);
    expect(out).toContain("hi");
  });

  it("rejects data: image URIs", () => {
    const out = sanitizeHelpHtml(
      '<img src="data:image/png;base64,AAAABBBB" alt="x">',
    );
    expect(out).not.toContain("data:");
  });

  it("neutralises javascript: links", () => {
    const out = sanitizeHelpHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toMatch(/javascript:/i);
  });

  it("keeps safe formatting, links, and headings", () => {
    const out = sanitizeHelpHtml(
      '<h2>Title</h2><p><strong>b</strong> <em>i</em></p><ul><li>one</li></ul><a href="https://x.com">link</a>',
    );
    expect(out).toContain("<h2>Title</h2>");
    expect(out).toContain("<strong>b</strong>");
    expect(out).toContain("<li>one</li>");
    expect(out).toContain('href="https://x.com"');
  });

  it("keeps image width + a valid data-align, drops a bogus one (spec 0026)", () => {
    const ok = sanitizeHelpHtml(
      '<img src="/api/help/images/x" alt="a" width="320" data-align="center">',
    );
    expect(ok).toContain('width="320"');
    expect(ok).toContain('data-align="center"');

    // A bogus value is dropped (js-xss may leave a valueless, inert `data-align`); the point is
    // no non-enum value survives, so the CSS `[data-align="..."]` selectors never apply it.
    const bad = sanitizeHelpHtml(
      '<img src="/api/help/images/x" data-align="javascript:alert(1)">',
    );
    expect(bad).not.toMatch(/data-align=/i);
    expect(bad).not.toMatch(/javascript:/i);
  });
});
