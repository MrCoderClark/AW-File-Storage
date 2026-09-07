# 0020 — Verification

## What shipped

- `next.config.ts` `headers()` — one rule for every path (`/:path*`): `Strict-Transport-Security`,
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`,
  and the full app policy in `Content-Security-Policy-Report-Only`. It sets **no enforced**
  `Content-Security-Policy` — clickjacking is fully covered by `X-Frame-Options: DENY` (no browser
  honors `frame-ancestors` but not XFO), and leaving that header key free lets the card route set
  its own strict enforced CSP without a config header overriding it.
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

1. **Headers present** — `curl -sI https://www.awvcard.com/sign-in` shows HSTS, `nosniff`,
   `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, an enforced
   `Content-Security-Policy: frame-ancestors 'none'`, and a `Content-Security-Policy-Report-Only`.
2. **Public card** — `curl -sI https://contacts.awvcard.com/c/<slug>` shows `nosniff`, `noindex`,
   and the strict landing CSP; `.vcf` and `.pdf` still `Content-Disposition: attachment` with `nosniff`.
3. **Clickjacking** — an `<iframe src="https://www.awvcard.com/sign-in">` on another origin is blocked.
4. **No breakage (browser console clean)** — load sign-in, the app shell, Files, Create/Edit card,
   the signature preview (`dangerouslySetInnerHTML`), a public landing page, the QR image, and a PDF
   download; the console shows **no** CSP-Report-Only violations and no mixed-content errors.
5. **Escaping** — a card whose name/title contains `'`, `<`, `"` renders escaped on the landing page
   and in the signature, with no markup break.

## Promote report-only → enforce (after check #4 is clean)

In `next.config.ts`, change the `Content-Security-Policy-Report-Only` entry's key to
`Content-Security-Policy` (same `APP_CSP` value). This does not touch the card route's own
enforced CSP (a different, more specific policy on `/c/*`). Re-run check #4 to confirm nothing
breaks under enforcement. **Follow-up before enforcing:** tighten `script-src` from
`'unsafe-inline'` to a per-request nonce so an injected inline `<script>` on an app page is
blocked (report-only tolerates it today).

## Operator step (config, not code)

Now that `contacts.awvcard.com` is served by the Worker, **disable the r2.dev public URL on
`aw-files-public`** so published cards are only reachable through the Worker (which adds
`noindex` + host gating). The objects are public by design, so this is hygiene, not a leak.
