import xssModule from "xss";

// Sanitize admin-authored help HTML (spec 0024 AC-8). This is load-bearing: the enforced app
// CSP allows `script-src 'unsafe-inline'` (spec 0020), so an inline <script> in stored HTML
// WOULD execute on app pages. Run this BOTH on save (in the article routes) and defensively on
// render (the /help pages).
//
// We use `xss` (js-xss): a whitelist sanitizer that is pure JS with no heavy dependencies, so
// it runs on the Cloudflare Workers runtime. (An earlier attempt with `sanitize-html` failed
// because it pulls in `postcss` → `nanoid`, which is not Workers-compatible.)
//
// `xss` is CommonJS. Under the Workers ESM interop only the DEFAULT export is reliable (the
// `filterXSS` function, with `FilterXSS` and `safeAttrValue` attached as properties); named
// imports come back undefined at runtime. So we reach the class + helper off the default.
const xss = xssModule as unknown as {
  FilterXSS: new (options?: unknown) => { process(html: string): string };
  safeAttrValue: (
    tag: string,
    name: string,
    value: string,
    cssFilter: unknown,
  ) => string;
};

const MAX_BODY_BYTES = 200 * 1024; // hard cap on stored body size (AC-8)

// The whitelist permits only safe formatting tags, links, and images; unknown tags are
// discarded and <script>/<style> bodies removed. `data:`/`javascript:` image sources are
// rejected so an author cannot smuggle inline base64 past the R2 pipeline or a script URL past
// the CSP. The app CSP `img-src` further restricts images to our own origin at render time.
const filter = new xss.FilterXSS({
  whiteList: {
    h1: [], h2: [], h3: [], h4: [],
    p: [], br: [], hr: [],
    ul: [], ol: [], li: [],
    blockquote: [], pre: [], code: [],
    strong: [], em: [], u: [], s: [], span: [],
    a: ["href", "title", "target", "rel"],
    img: ["src", "alt", "width", "height"],
    table: [], thead: [], tbody: [], tr: [], th: [], td: [],
  },
  stripIgnoreTag: true, // discard tags not on the whitelist (don't escape them)
  stripIgnoreTagBody: ["script", "style"], // remove these tags AND their contents
  safeAttrValue(tag: string, name: string, value: string, cssFilter: unknown) {
    // Reject data:/javascript: image sources outright (js-xss allows some data: by default).
    if (tag === "img" && name === "src" && /^\s*(data|javascript):/i.test(value)) {
      return "";
    }
    return xss.safeAttrValue(tag, name, value, cssFilter);
  },
});

/** Sanitize help article HTML: strip anything not on the whitelist, cap the size. */
export function sanitizeHelpHtml(html: string): string {
  const clipped =
    html.length > MAX_BODY_BYTES ? html.slice(0, MAX_BODY_BYTES) : html;
  return filter.process(clipped);
}
