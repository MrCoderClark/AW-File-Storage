import sanitizeHtml from "sanitize-html";

// Sanitize admin-authored help HTML (spec 0024 AC-8). This is load-bearing: the enforced app
// CSP allows `script-src 'unsafe-inline'` (spec 0020), so an inline <script> in stored HTML
// WOULD execute on app pages. We use `sanitize-html` because it parses via htmlparser2 and
// needs no DOM, so it runs on the Cloudflare Workers runtime (unlike DOMPurify, which needs a
// document). Run this BOTH on save (in orgDb().help.create/update) and defensively on render.
//
// The allowlist permits only safe formatting tags, links (https/mailto, forced noopener), and
// images whose scheme is https — `data:` URIs are rejected so an author cannot smuggle large
// inline base64 images past the R2/quota pipeline. The app CSP `img-src` further restricts
// images to our own origin at render time.

const MAX_BODY_BYTES = 200 * 1024; // hard cap on stored body size (AC-8)

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "h1", "h2", "h3", "h4", "p", "br", "hr",
    "ul", "ol", "li",
    "blockquote", "pre", "code",
    "strong", "em", "u", "s", "span",
    "a", "img",
    "table", "thead", "tbody", "tr", "th", "td",
  ],
  allowedAttributes: {
    a: ["href", "title", "target", "rel"],
    img: ["src", "alt", "width", "height"],
    span: [],
    "*": [],
  },
  allowedSchemes: ["https", "mailto"],
  // Images may only use https (our /help/images route); no `data:`, no `javascript:`.
  allowedSchemesByTag: { img: ["https"] },
  disallowedTagsMode: "discard",
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer nofollow" }),
  },
};

/** Sanitize help article HTML: strip anything not on the allowlist, cap the size. */
export function sanitizeHelpHtml(html: string): string {
  const clipped =
    html.length > MAX_BODY_BYTES ? html.slice(0, MAX_BODY_BYTES) : html;
  return sanitizeHtml(clipped, OPTIONS);
}
