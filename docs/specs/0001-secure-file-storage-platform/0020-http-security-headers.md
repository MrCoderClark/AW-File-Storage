# 0020. HTTP security headers & response hardening

**Date**: 2026-09-07
**Status**: Proposed

## Summary

The application currently sends **no HTTP security headers** on its own responses.
`next.config.ts` defines no `headers()`, and `src/proxy.ts` only does the CSRF/origin
check — it never adds response headers. Individual public routes set `X-Robots-Tag`
and `Cache-Control`, but nothing sets `Content-Security-Policy`,
`Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`,
`Permissions-Policy`, or a frame/clickjacking protection. This spec adds a single,
architecture-appropriate set of security headers to every response, and closes a
latent HTML-escaping gap, without breaking the app's real resource needs.

This is a **hardening** spec: it found no active exploit, but the app's admin console,
sign-in page, and the `dangerouslySetInnerHTML` signature preview all run with no
defense-in-depth against clickjacking, transport downgrade, or a future injection.

## Context

Findings from the security audit (SECURITY.md) that this spec addresses:

- **No clickjacking protection.** `www.awvcard.com` — including `/sign-in`, `/settings`,
  member management, and the org-delete confirm — can be framed by any origin. There is
  no `X-Frame-Options` / CSP `frame-ancestors`.
- **No HSTS.** No `Strict-Transport-Security`, so a first request can be downgraded.
- **No `X-Content-Type-Options: nosniff`.** The published `.vcf` (`src/app/c/[slug]/route.ts`)
  and served logos (`src/app/logos/[org]/[file]/route.ts`) rely on the declared
  Content-Type; a sniffing browser could reinterpret them.
- **No Content-Security-Policy.** The app renders a server-built HTML string through
  `dangerouslySetInnerHTML` in `src/components/signature-view.tsx` (the signature
  preview built by `src/lib/signature-html.ts`). That builder escapes correctly today,
  so this is defense-in-depth, not a live hole — but there is no CSP backstop if an
  escape is ever missed.
- **No `Referrer-Policy` / `Permissions-Policy`.**
- **Latent escaping gap.** The `esc()` helpers in `src/lib/card-landing-html.ts` and
  `src/lib/signature-html.ts` escape `& < > "` but **not** the single quote `'`. Every
  attribute in both builders is double-quoted, so this is not currently exploitable, but
  it is a footgun the moment any attribute is written single-quoted.
- **Config hygiene (non-code).** Per `docs/PROGRESS.md`, the r2.dev public dev URL may
  still be enabled on `aw-files-public`; published cards are then reachable directly at
  the r2.dev host, bypassing the Worker's `noindex` + host gating + counting. The content
  is public by design, so this is hygiene, not a leak — noted here as an operator step.

Constraints that shape the CSP (audit rule: do not add a CSP that breaks the app):

- The app is Next.js on OpenNext/Workers. Next injects inline bootstrap `<script>` and
  streaming chunks, so a nonce-based or `'strict-dynamic'` script policy is required —
  a blanket `script-src 'self'` would break hydration.
- The card landing page and the signature both use **inline `<style>`** and load
  **`<img>` from the same host** (logo, QR, social PNGs). Images also come from R2/logos
  on the same host. No third-party script, font, or style origins are used.
- QR/OG image references are same-origin (`/api/cards/[id]/qr`).

## Requirements

**User stories**:
- As the platform owner, I want the app to refuse to be embedded in another site's
  frame, so a clickjacking overlay can't trick a signed-in admin into a destructive click.
- As a security reviewer, I want a baseline of modern security headers on every response,
  matched to what the app actually loads, so a scanner and an auditor both pass.
- As a maintainer, I want one place that owns these headers, so they can't silently
  regress per-route.

**Acceptance criteria**:
- **AC-1 (single owner)**: Security headers are applied in **one** place that covers all
  responses — `src/proxy.ts` (which already runs on every non-static path) and/or
  `next.config.ts` `headers()`. A per-route override is allowed only where a route has a
  documented reason (e.g. the landing page's own `Content-Security-Policy` if it needs a
  stricter/looser one than the app).
- **AC-2 (clickjacking)**: Every app response carries `Content-Security-Policy:
  frame-ancestors 'none'` (and `X-Frame-Options: DENY` for older clients). The app is
  never framed. If a future feature must be embeddable, it is opted in explicitly, never
  by default.
- **AC-3 (HSTS)**: Every response carries `Strict-Transport-Security: max-age=63072000;
  includeSubDomains` (2 years). `preload` is added only after the owner confirms every
  subdomain is HTTPS-only (documented in verify, not enabled blindly).
- **AC-4 (nosniff + referrer + permissions)**: Every response carries
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  and a restrictive `Permissions-Policy` (disable `camera`, `microphone`, `geolocation`,
  `payment`, `usb`, and other features the app does not use).
- **AC-5 (CSP for the app)**: The app host serves a `Content-Security-Policy` that at
  least sets `default-src 'self'`, `object-src 'none'`, `base-uri 'self'`,
  `frame-ancestors 'none'`, `img-src 'self' data:`, `style-src 'self' 'unsafe-inline'`
  (the app and the signature preview use inline styles), and a **script policy that does
  not break Next.js hydration** — a nonce or `'strict-dynamic'` approach, verified by
  loading every app page with the browser console clean of CSP violations. The CSP must
  be proven against the real app before enforcement; it may ship first in
  `Content-Security-Policy-Report-Only` to confirm zero violations, then be enforced.
- **AC-6 (public card + logo responses)**: The `/c/<slug>` landing, `/c/<slug>.vcf`,
  `/c/<slug>.pdf`, and `/logos/<org>/<file>` responses keep their existing `noindex` and
  `Cache-Control`, and additionally carry `nosniff`. The `.vcf`/`.pdf` keep
  `Content-Disposition: attachment`. The landing page's CSP allows its inline style and
  same-host images and forbids scripts entirely (`script-src 'none'` — the landing page
  ships no JS), so a stored-XSS attempt in card data has a second backstop.
- **AC-7 (escaping backstop)**: `esc()` in both `src/lib/card-landing-html.ts` and
  `src/lib/signature-html.ts` also escapes `'` → `&#39;` (and `` ` `` is not required in
  HTML but the change is a one-liner), so the helper is safe for single- or
  double-quoted attributes. No behavioral change to existing output (existing values
  contain no bare `'` in a quote-breaking position because attributes are double-quoted).
- **AC-8 (no functional regression)**: After the headers land, every existing surface
  still works: sign-in, the app shell, Files, Create/Edit card, the signature preview
  (`dangerouslySetInnerHTML`), the public landing page, QR image, PDF download, and logo
  images. Verified with the browser console free of CSP/mixed-content errors.

## Decision

**Chosen approach**: add the static headers (`HSTS`, `nosniff`, `Referrer-Policy`,
`Permissions-Policy`, `X-Frame-Options`, and the `frame-ancestors` CSP) in one shared
place, and introduce the fuller `Content-Security-Policy` behind a **report-only → enforce**
rollout so it is proven against the live app before it can break hydration. Keep the
public card/logo routes' existing per-response headers and only add `nosniff` + a
script-free CSP there.

**Rejected**:
- A single global blanket CSP with `script-src 'self'` — breaks Next.js inline bootstrap
  and streaming; would take down the app.
- Adding headers per-route — guarantees drift and a missed route; the audit explicitly
  wants one owner.
- Enabling HSTS `preload` immediately — irreversible for ~months if a non-HTTPS subdomain
  exists; gated behind an explicit operator confirmation.

## Feature design

**Where the headers live.** `src/proxy.ts` already runs on `["/((?!_next/static|_next/image|favicon.ico).*)"]`
for every method. Extend it (or pair it with `next.config.ts` `headers()`) so that on the
way out every response gains the static header set. The proxy currently early-returns
`NextResponse.next()` for non-mutating requests and a bare 403 for CSRF failures — the
header application must cover the `NextResponse.next()` path (the normal case) and should
be attached via `NextResponse.next({ headers })` / a response header mutation so it
reaches downstream responses. If proxy header mutation proves unreliable on the OpenNext
runtime, fall back to `next.config.ts` `headers()` for the static ones and keep the CSP
nonce wiring where Next can inject it.

**Header set (app host)**:

| Header | Value |
|---|---|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()` |
| `Content-Security-Policy` | `default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'nonce-…' 'strict-dynamic'; connect-src 'self'` (proven via report-only first) |

**Public card/logo responses** keep `X-Robots-Tag: noindex, nofollow` and their
`Cache-Control`, add `X-Content-Type-Options: nosniff`, and use a script-free CSP
(`default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'`)
since the landing page ships zero JavaScript.

**Escaping backstop.** One-line change to each `esc()` to also replace `'`.

**Operator step (not code).** Document, in `0020-verify.md`, disabling the r2.dev public
URL on `aw-files-public` now that `contacts.awvcard.com` is served by the Worker, so
published cards are only reachable through the Worker (with its `noindex` + gating).

**Key invariants**:
- One place owns the static headers; no route silently drops them.
- The CSP is proven in report-only mode against every app surface before enforcement.
- The public landing page forbids script entirely, so card data can never execute.

## Verification

See `0020-verify.md`. Checks: a scanner (e.g. securityheaders.com / `curl -I`) shows all
six headers on the app host and on a public card URL; the app cannot be framed
(`frame-ancestors 'none'` observed, an `<iframe>` of `/sign-in` is blocked); loading
sign-in, the app shell, Files, Create/Edit card, the signature preview, a public landing
page, the QR image, and a PDF download all leave the browser console free of CSP and
mixed-content errors; the `.vcf` and `.pdf` still download as attachments with
`nosniff`; unit test that `esc("a'b<c")` escapes the quote and the angle bracket.
Manual operator confirmation that the r2.dev public URL is disabled.

## Out of scope (later)

CSP violation reporting to an endpoint/Sentry; Subresource Integrity (no third-party
scripts today); `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` isolation
(no cross-origin isolation need yet); HSTS `preload` submission.
