# 0020 — Verification

## What shipped

- `next.config.ts` `headers()` — one rule for every path (`/:path*`): `Strict-Transport-Security`,
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`,
  and the full app policy as an **enforced** `Content-Security-Policy` (promoted from report-only —
  spec 0020 follow-up, Option A). `script-src` keeps `'unsafe-inline'` (Next's inline bootstrap),
  so it blocks foreign scripts/object/base-uri/cross-origin exfiltration but not an injected inline
  script; the nonce hardening that would close that is an optional future step. On `/c/*` this
  policy intersects with the route's own stricter, script-free CSP (a safe intersection — `img-src`
  here also allows the public file domain so an uploaded logo still resolves under the intersection);
  scripts stay blocked there via the route's `default-src 'none'`.
- `src/app/c/[slug]/route.ts` — `nosniff` on every response (`.vcf`/`.pdf`/landing/404); the landing
  HTML sets an **enforced, script-free** `Content-Security-Policy: default-src 'none'; img-src 'self'
  https://<PUBLIC_FILE_DOMAIN> data:; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors
  'none'; form-action 'none'`. `img-src` allows the public file domain as well as `'self'` so an
  org's uploaded state logo (stored on the contacts host) renders even when the page is previewed
  on the app host; there is no `script-src`.
- `src/app/logos/[org]/[file]/route.ts` — `nosniff` added.
- `esc()` in `src/lib/card-landing-html.ts` and `src/lib/signature-html.ts` now also escapes
  `'` → `&#39;` (safe in single- and double-quoted attributes; renders identically).

## Checks

1. **Headers present** — `curl.exe -sI https://www.awvcard.com/sign-in` shows HSTS, `nosniff`,
   `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, and an **enforced**
   `Content-Security-Policy` carrying the full `APP_CSP` (no longer report-only).
2. **Public card** — `curl.exe -sI https://contacts.awvcard.com/c/<slug>` shows `nosniff`, `noindex`,
   and the strict landing CSP; `.vcf` and `.pdf` still `Content-Disposition: attachment` with `nosniff`.
3. **Clickjacking** — an `<iframe src="https://www.awvcard.com/sign-in">` on another origin is blocked.
4. **No breakage under ENFORCEMENT (browser console clean)** — this is the critical check now that
   the policy blocks, not just reports. Load sign-in, the app shell, Files, Create/Edit card, the
   signature preview (`dangerouslySetInnerHTML`), a public landing page (incl. one with an uploaded
   state logo on the `www` host), the QR image, and a PDF download; the console must show **no** CSP
   violations and no blocked resources. If anything is blocked, the fix is to widen the specific
   directive in `APP_CSP` (or roll back to report-only by renaming the header key).
5. **Escaping** — a card whose name/title contains `'`, `<`, `"` renders escaped on the landing page
   and in the signature, with no markup break.

## Status: CSP enforced (Option A)

The full app policy is now enforced with `script-src 'self' 'unsafe-inline'` — zero hydration-risk,
blocking foreign scripts, object/embed, base-uri hijacking and cross-origin exfiltration. **Optional
future hardening:** tighten `script-src` to a per-request nonce (`'self' 'nonce-…' 'strict-dynamic'`)
so an injected inline `<script>` is also blocked. That requires wiring a nonce through `proxy.ts`,
forces some static pages dynamic, and needs a report-only re-validation on the OpenNext runtime first
(it can break hydration if the nonce isn't propagated) — hence deferred. The one surface that renders
user-supplied content (the `/c` page) is already script-free, so the residual app-page risk is low.

## Operator step (config, not code)

Now that `contacts.awvcard.com` is served by the Worker, **disable the r2.dev public URL on
`aw-files-public`** so published cards are only reachable through the Worker (which adds
`noindex` + host gating). The objects are public by design, so this is hygiene, not a leak.
