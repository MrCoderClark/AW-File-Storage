# 0009. Host-based access + counting for published card pages

**Date**: 2026-09-02

## Summary

Published card pages are served by one Worker on two hostnames: the public `contacts.awvcard.com` and the app's `www.awvcard.com`. Today both serve the page to anyone, and both can record engagement. This spec splits behaviour by hostname: `contacts.awvcard.com` stays fully public (its `.vcf` is embedded in Office 365 mailboxes and its pages are the QR targets), while `www.awvcard.com/c/*` becomes a logged-in-only staff preview that never counts. The result: the public directory of staff contact details lives on exactly one domain instead of two, and the engagement counts reflect only real outside traffic, never staff previews. No database change; the split is purely by request host.

## Context

The public card feature (spec 0008) put the landing page and the `.vcf` download on a single Worker route, `src/app/c/[slug]/route.ts`, reachable at both `contacts.awvcard.com` (the public file domain, `PUBLIC_FILE_DOMAIN`) and `www.awvcard.com` (the app, `APP_URL`). The in-app "preview" (clicking a card name on the Files page) opens the page on `www` because that link is same-origin.

Two problems follow. First, the same public directory of real staff contact details (name, title, direct phone, email, address) is served on the app domain as well as the public one. The operator is concerned about that data being scraped for phishing or spam, and wants it exposed on as few surfaces as possible. The `contacts` copy cannot be locked down: its `.vcf` address is stored in each person's Office 365 Exchange mailbox `customAttribute1`, and QR codes and email signatures point at `contacts` pages, so outside people (job seekers, employers) who are not site users must be able to reach it. The `www` copy, by contrast, is only ever used by logged-in staff, so it does not need to be public at all.

Second, counting keys off a `?preview=1` query flag rather than who is asking. Staff previewing a card (or opening its `.vcf` from a preview) inflate the view and download counts. A flag on the in-app link is fragile: it does not cover a staff member opening a raw URL, and it is easy to get wrong.

A hard constraint shapes everything: the Better Auth session cookie is scoped to `www.awvcard.com` (the auth `baseURL` is `APP_URL`) and is not sent to `contacts.awvcard.com`. So the app can know who a caller is on `www`, but has no identity signal at all on `contacts`.

## Requirements

**User stories**:
- As an outside recipient, I want a QR code or an emailed `.vcf` link to open the card with no login, so that I can save the contact.
- As the operator, I do not want the app domain (`www`) to double as a second public directory of staff contact details.
- As the operator, I want the engagement numbers to reflect only real outside interest, not staff looking at their own cards.
- As a staff member, I want to preview any published card from the Files page without being counted and without a public page being exposed under my login.

**Acceptance criteria**:
- **AC-1**: On the public host (`contacts.awvcard.com`, i.e. `PUBLIC_FILE_DOMAIN`), both `/c/<slug>` (landing page) and `/c/<slug>.vcf` (download) are served to anyone with no login, exactly as before. Unpublished, private, or unknown slugs still return 404.
- **AC-2**: On the app host (`www.awvcard.com`, and any other non-public host such as the `workers.dev` URL), `/c/*` requires a logged-in session. A request with no valid session is redirected to `/sign-in`.
- **AC-3**: Engagement is counted only for requests on the public host. A request on the app host (a staff preview) never increments any view, scan, or download counter.
- **AC-4**: QR codes, email signatures, and the Office 365 `.vcf` link, which all target `contacts.awvcard.com`, keep working unchanged.
- **AC-5**: The Files-page card-name link opens the landing page on the app host, served to the caller's existing session, and records no count.
- **AC-6**: The `?preview=1` mechanism is removed; no behaviour depends on it. Counting is decided by host, not by a query flag.

## Options considered

### Option 1: Split behaviour by request host (chosen)

Branch the existing `/c/[slug]` route on `url.host`. Public host serves publicly and counts; any other host requires a session (redirect to `/sign-in` when absent) and never counts. Remove `?preview=1`. A fix in place, no new surface.

**Pros**:
- Meets the exact requirement: `contacts` stays public (O365/QR safe), `www` stops being a public directory.
- Uses the identity signal that already exists on `www` (the session cookie), so no new auth infrastructure.
- Makes counting reflect real outside traffic and removes the fragile flag in one move.

**Cons**:
- The data is still public on `contacts` (it must be), so this reduces the exposed surface from two domains to one; it is not a data-secrecy control.
- The route now has two behaviours; a reader must know which host is which.

### Option 2: Require login on the public `contacts` URLs

Gate the `contacts` landing and `.vcf` behind a session too.

**Pros**:
- Would actually make the card data non-public.

**Cons**:
- Breaks the core use case: outside people scanning a QR on a business card, and the Office 365 `.vcf` link, are not site users and would be blocked. This defeats the product's purpose, so it is rejected.

### Option 3: Cross-subdomain cookies so `contacts` can identify staff

Share the auth cookie across `.awvcard.com` and skip counting for logged-in users on `contacts`.

**Pros**:
- Would let staff opening a raw `contacts` URL be excluded from counts too.

**Cons**:
- Sends the session cookie to the public, cacheable surface, undoing the clean public/private split; forces every user to sign in again when the cookie domain changes; adds a session lookup on every public hit. Disproportionate, so rejected.

### Option 4: A per-card public/private toggle

Add a stored flag per card (and an org default) to mark cards public or authenticated, with UI to manage it.

**Pros**:
- Fine-grained control if some cards should be private.

**Cons**:
- The stated requirement is simply "keep `contacts` public, make `www` not public", which needs no per-card state. Deferred as unneeded now; revisit if real private cards are ever required.

## Decision

**Chosen option**: Option 1: the `/c/[slug]` route branches on the request host. The public host (`PUBLIC_FILE_DOMAIN`) is served publicly and is the only surface that counts; every other host requires a logged-in session and never counts. The `?preview=1` flag is removed.

## Rationale

The binding constraints settle it. The `contacts` surface cannot be locked down (Office 365 and QR codes depend on it being public for non-users), and the session cookie only exists on `www`, so host is the one identity signal available. Gating `www` therefore costs nothing we have and removes a real concern: the app domain no longer serves a second public copy of the directory, and every hit that reaches the app host is by definition an authenticated staff member, so excluding it from counts is exact rather than heuristic. That also retires the `?preview=1` flag, which only ever half worked. This is a smaller, more honest control than the rejected options: it does not pretend to make public data secret (Option 2/3 would have to break O365 or leak cookies to try), and it does not add per-card state the requirement does not call for (Option 4).

## Feature design

**Data model sketch**: no change. No new tables, columns, or per-card flags. Access is decided entirely by the request host at serve time.

**Request handling** (`src/app/c/[slug]/route.ts`):
- Compute `isPublicHost = url.host === (env.PUBLIC_FILE_DOMAIN ?? default)`.
- If not the public host: call `getSession()` (`src/server/session.ts`); if there is no session, return a redirect to `/sign-in` (absolute URL built from the request URL). If there is a session, serve the page.
- Counting: the hit is recorded only when `isPublicHost` is true. The app host serves the same content but records nothing.
- The `?preview=1` branch and the flag-carrying `vcfUrl`/`landingUrl` are removed; the landing's "Add to contacts" link and the Files name link use the plain `/c/<slug>` and `/c/<slug>.vcf` on whatever host served them.

**API surface**:

| Endpoint | Host | Method | Auth | Behaviour |
|---|---|---|---|---|
| `/c/<slug>` | `contacts` | GET | public | landing page; counts a view |
| `/c/<slug>?src=qr` | `contacts` | GET | public | landing page; counts a scan |
| `/c/<slug>.vcf` | `contacts` | GET | public | vCard bytes; counts a download |
| `/c/<slug>` and `/c/<slug>.vcf` | `www` (or other non-public host) | GET | session required | same content to a logged-in staff member; **never counts**; redirect to `/sign-in` if logged out |

**Key invariants**:
- A request is counted only if it arrived on the public host.
- The public host's behaviour (content, headers, 404s, `noindex`, byte-identical `.vcf`) is unchanged from spec 0008.
- The app-host gate checks authentication only, not authorization: any logged-in user may preview any published card. It is not a data-protection control (the same data is public on `contacts`); its job is to keep the app domain from serving a public directory and to guarantee app-host hits are staff.

**Security model**:
- `contacts` host: unauthenticated read of already-public published card data; unpublished/private/deleted slugs 404 (unchanged).
- `www` (and other non-public hosts): a valid session is required; no per-card or per-org check, by the reasoning above. The redirect target `/sign-in` is a public page, so there is no loop for a logged-out visitor.

**Configuration required**: none. Uses the existing `PUBLIC_FILE_DOMAIN` and the existing auth session.

**Critical test scenarios** (each maps to an acceptance criterion):
- Public still open: `GET contacts.awvcard.com/c/<slug>` and `…/<slug>.vcf` with no cookie return 200 and increment the right counter; a bogus slug 404s. Verifies **AC-1, AC-3, AC-4**.
- App host gated: `GET www.awvcard.com/c/<slug>` with no session redirects to `/sign-in`; with a valid session it returns 200 and increments nothing. Verifies **AC-2, AC-3, AC-5**.
- Flag gone: no code path reads `preview`; the Files name link and the landing "Add to contacts" carry no flag. Verifies **AC-6**.

## Build plan

Single end-to-end change to one route plus the two link sources; no migration, so it is one coherent slice (no recorded build approach for this feature; end-to-end slice assumed).

1. Host gate in `src/app/c/[slug]/route.ts`: compute `isPublicHost` from `PUBLIC_FILE_DOMAIN`; when not public, require `getSession()` or redirect to `/sign-in`. Satisfies **AC-1, AC-2**.
2. Host-based counting in the same route: record a hit only when `isPublicHost`; delete the `?preview=1` branch. Satisfies **AC-3, AC-6**.
3. Drop the flag from the link sources: `landingUrl` in `src/server/uploads.ts` becomes `/c/<slug>` (no `?preview=1`); the route's landing `vcfUrl` becomes the plain same-host `/c/<slug>.vcf`; `files-view.tsx` needs no change beyond consuming the updated `landingUrl`. Satisfies **AC-5, AC-6**.
4. Verify per the scenarios above (public open + counted; app host gated + not counted; QR/O365 unaffected; logos/signature unaffected). Satisfies **AC-1..AC-6**.

## Consequences

**Positive**:
- Staff contact details are served publicly on one domain (`contacts`) instead of two.
- Engagement counts reflect only real outside traffic; staff previews are structurally excluded, not flag-dependent.
- Removes the fragile `?preview=1` mechanism.
- No database change, no migration; ships in a single deploy and reverts by reverting the one commit.

**Negative / tradeoffs**:
- The card data remains public on `contacts` (unavoidable given O365/QR); this narrows the exposed surface but is not a secrecy control. Scraping defence for `contacts` (rate limiting, bot protection, keeping `noindex`) is a separate concern.
- The `/c` route now behaves differently per host, which a future reader must understand.
- A logged-out person who follows a `www` card link lands on `/sign-in` rather than the card; intended, but a mild surprise if a `www` link is ever shared outward (the shareable link is the `contacts` one).

**Neutral**:
- The app-host gate is authentication only; it deliberately does not restrict which staff member may preview which card.

## Follow-up

- [ ] Optional: carry a `returnTo` on the `/sign-in` redirect so a logged-out staff member who clicked a `www` card link lands back on it after signing in.
- [ ] Separate from this spec: decide whether to add rate limiting / Cloudflare bot protection on the public `contacts` surface to blunt mass scraping of the (necessarily public) card data.
- [ ] If genuinely private cards are ever needed, revisit Option 4 (per-card public/authenticated toggle) as its own spec.
