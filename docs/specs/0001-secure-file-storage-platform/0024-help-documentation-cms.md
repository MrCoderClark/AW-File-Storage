# 0024. In-app help & documentation (admin-editable CMS)

**Date**: 2026-09-08
**Status**: Proposed

## Summary

Replace the placeholder **bell** icon in the app header with a **help (`?`)** icon that
opens a slide-over **Help drawer**, backed by an **admin-editable help CMS**. Each
organization's owners/admins author rich-text articles (Tiptap WYSIWYG, with image
uploads), saved as draft then published. The **platform owner** can additionally mark an
article as **shared**, making it visible to every organization. Staff read help two ways:
the quick **drawer** (search + "for this page" contextual links + a contact-support link)
and a full **`/help`** library page. Articles live in Cloudflare D1, images in R2, and all
admin-authored HTML is **sanitized** so it can never become stored XSS.

## Context

The header's bell button (`src/components/app-header.tsx`) has **no behaviour** — no click
handler, no notifications — so removing it loses nothing.

This feature reuses what the app already has: the org-isolation wrapper `orgDb(orgId)`
(spec 0002); presigned direct-to-R2 uploads (`src/server/uploads.ts`, `src/server/r2.ts`);
role gating (`requireApiRole` / `requireOrgRole`) and the platform-owner tier
(`isPlatformOwner`, spec 0012); the insert-only audit log; the off-canvas drawer pattern
(`src/components/app-shell-body.tsx`) and `ConfirmDialog`; and the Tailwind v4 navy/red AW
styling.

**Security constraint (spec 0020):** the enforced app CSP allows `script-src 'self'
'unsafe-inline'`, so an inline `<script>` in stored HTML *would* execute on app pages.
Admin-authored rich text must therefore be sanitized on save (and defensively on render).

## Requirements

**User stories:**
- As a staff member, I click the `?` in the header and get a quick help drawer showing
  articles relevant to the page I'm on, a search box, and a way to open the full library.
- As an org owner/admin, I write and edit help articles in a visual editor with images,
  saving as a draft and publishing when ready.
- As the platform owner, I can share selected articles so they appear in every org's help.
- As a staff member, I can reach a human via a "Contact support" link when docs aren't enough.

**Acceptance criteria:**
- **AC-1 (header icon)**: The bell is removed; a `?` help icon (accessible label, AW styling)
  takes its place and opens the Help drawer.
- **AC-2 (drawer)**: A right-side slide-over with: a search box; a **"For this page"** list
  (published articles whose `pageKey` matches the current route); a browse-by-category list;
  an **Open full help** link to `/help`; and a **Contact support** `mailto` footer. Closes on
  Esc/backdrop, focus-trapped, responsive to 360px.
- **AC-3 (full page)**: `/help` renders inside the app shell — categorized list, article view
  with sanitized rich content and images, same search.
- **AC-4 (read scope)**: Any signed-in member sees **published** articles that are **their
  org's own OR shared**. Drafts are never shown to readers. This own-org-∪-shared union is a
  documented, isolation-tested data-layer method (`listForReader()`). Reader/article routes use
  the article **id**, not the slug (slug is cosmetic), so two orgs' identical slugs can never
  collide in a reader's merged view.
- **AC-5 (authoring)**: An org **owner/admin** can create, edit, delete, and reorder **their
  org's** articles via a Tiptap editor. Fields: title, cosmetic slug, category, rich body,
  optional `pageKey`, status `draft`/`published`. All writes are org-scoped through `orgDb`
  (the caller's own `activeOrganizationId`).
- **AC-6 (sharing, platform-owner only)**: The shared content lives in the **platform owner's
  own organization** — the platform owner authors it there like any admin (normal org-scoped
  writes) and may additionally set/clear each article's `shared` flag. Only a caller who is the
  platform owner (`isPlatformOwner`), acting in their own org, may toggle `shared`; an org admin
  who is not the platform owner never can. A shared, published article appears in every org's
  help, read-only to other orgs. **There is no cross-org write path**: sharing is an own-org
  write, so `orgDb` still uses the caller's own org (AGENTS.md rule 1 holds). (Sharing an article
  a *different* org authored is out of scope; see Follow-up.)
- **AC-7 (images, authorized not just login-gated)**: Authors upload images in the editor;
  stored in R2 (private, `help/<org>/…`), recorded in `help_image` with the owning `org_id` and
  the `article_id` they belong to. The serve route **authorizes**, not merely requires login: a
  caller may fetch an image only if it belongs to **their own org** OR it is referenced by a
  currently **published + shared** article. A member of one org can never fetch another org's
  draft or non-shared help image by id. Not publicly enumerable.
- **AC-8 (sanitization)**: Article HTML is sanitized on **save** against a strict allowlist
  (no `<script>`, `<style>`, `<iframe>`, no `on*` handlers, no `javascript:` URLs; only safe
  formatting tags, links, and `<img>` whose `src` is our own `/help/images/*` route — **`data:`
  image URIs are rejected** so base64 can't bypass the R2/quota pipeline) and sanitized again on
  render (the only `dangerouslySetInnerHTML` call sites, fed sanitized HTML only). `body_html`
  has a maximum size. No admin-authored content can execute script.
- **AC-9 (search)**: Client-side instant search over the reader's visible published set, run over
  **pre-sanitized plain-text** title/excerpt. Match highlighting is done by safe text-node
  rendering, never by concatenating raw HTML — so search is not a third injection surface.
- **AC-10 (isolation + audit)**: Every article/image **write** goes through `orgDb` with the
  caller's own org; the **only** cross-org operations are two documented, isolation-tested
  **reads** — `listForReader()` (AC-4) and the shared-image serve authorization (AC-7). No
  cross-org write exists. Create/update/delete/publish/share are audited. Migrations are additive
  (new leaf tables; no parent rebuild — gotcha #9).

## Decision

**Chosen approach:** a **per-org** help CMS (`help_article` carries `org_id`, edited by that
org's owner/admin) **plus a platform-owner-controlled `shared` flag** for cross-org
visibility. Rich text is authored with **Tiptap** and stored as **sanitized HTML**; images
go to the **private R2 bucket** behind a login-gated serve route. The header `?` opens a
slide-over drawer; the full library is `/help`.

**Why sharing works this way:** "share to other orgs" is inherently cross-tenant, and the
isolation model forbids a cross-org *write* (every write uses the caller's own
`activeOrganizationId`; `isPlatformOwner` is only an email check, unrelated to any target
org). So instead of an org admin injecting content into other tenants, the platform owner
**authors the shared/global help inside their own org** (a normal org-scoped write) and flips
a `shared` flag on it. Sharing therefore never needs a cross-org write path; the only
cross-org operations in the whole feature are the two reads in AC-10. This keeps AGENTS.md
rule 1 intact and makes the platform owner the single maintainer of global content.

**Rejected:** static in-repo Markdown (you want no-code editing); storing raw unsanitized
HTML (stored-XSS given the CSP allows inline script on app pages); a public image bucket
(needless exposure for login-walled help); org-admin cross-org sharing (isolation risk).

## Feature design

**Data model** (additive; org-scoped tenant tables, reached through `orgDb`):

| Table | Key columns | Notes |
|---|---|---|
| `help_article` | `id`, `org_id` (FK cascade), `title`, `slug` (cosmetic), `category`, `body_html` (sanitized), `excerpt`, `page_key` (nullable), `status` (`draft`/`published`), `shared` (bool, default false), `sort_order`, `published_at`, `created_at`, `updated_at`, `updated_by` (user FK) | Routing uses `id`, so `slug` needs no cross-org uniqueness (avoids the merged-view collision). Indexes: `(org_id, status, category, sort_order)`, `(org_id, page_key)`, and `(shared, status)` for the shared read. |
| `help_image` | `id`, `org_id` (FK cascade), `article_id` (FK `help_article`, nullable until first save), `r2_key`, `content_type`, `uploaded_by`, `created_at` | `article_id` is what the serve route authorizes against (AC-7) and what lets orphaned images be swept; set/refreshed when the sanitized body is saved. |

**The two sanctioned cross-org reads (no cross-org write).** (1) Readers see `own-org
published ∪ shared published (any org)` via one named `orgDb().help.listForReader()`. (2) The
image serve route may return an image from another org only when it is referenced by a
published+shared article (AC-7). Both are the deliberate exceptions to strict org-scoping;
each is documented, added to the `no-db-bypass` allowlist, and covered by an isolation test (a
non-shared org-A article/image never appears for org B). Every *write* stays strictly
org-scoped. The `(shared, status)` index intentionally does not lead with `org_id` (it serves
the cross-org shared read); note this exception in the `org-db.ts` header comment, whose
current "every method constrains to orgId" wording the `listForReader` OR-query otherwise
contradicts.

**Surfaces:**
- **Header** (`app-header.tsx`): remove the `Bell` button + icon; add a `?` help button that
  toggles the drawer (client state; drawer rendered via a portal like the rail drawer).
- **Help drawer** (new client component): search, "For this page" (from a `pageKey` derived
  from `usePathname`), category list, Contact support `mailto` (address from config/env
  placeholder), Open full help → `/help`.
- **`/help`** (`src/app/(app)/help/page.tsx`): server-loads the reader's visible articles;
  categorized browse + article view (sanitized HTML render) + search.
- **Admin editor** (`src/app/(app)/settings/help/…`, owner/admin): article list with
  reorder, Tiptap editor, draft/publish, delete (confirm), image upload. The platform owner
  additionally sees a **Share to all orgs** toggle per article.

**API / server:**
- `GET /api/help` — reader feed (visible published union), member-gated.
- `GET/POST /api/help/articles`, `PATCH/DELETE /api/help/articles/[id]` — owner/admin,
  org-scoped; draft/publish/reorder.
- `PATCH /api/help/articles/[id]` `shared` change — gated `isPlatformOwner`.
- `POST /api/help/images` — presigned upload (reuses the R2 path), recording a `help_image`
  row; `GET /help/images/[id]` — **authorized** serve from the private bucket (own-org, or
  referenced by a published+shared article; AC-7), not merely login-gated.
- Server layer: `orgDb().help` (article CRUD, image records, `listForReader()` union). HTML is
  sanitized in this layer before insert/update.

**Sanitization:** run Tiptap's HTML output through a strict allowlist sanitizer server-side
before storing, and again on render. Use a **DOM-free, Workers-safe** sanitizer (e.g.
`sanitize-html`, which parses via htmlparser2 and needs no `document`); DOMPurify is avoided
because it needs a DOM the Workers runtime lacks. This is load-bearing for build step 2, so
confirm the choice bundles under `opennextjs-cloudflare build` **before** the server layer is
built, not as an after-the-fact follow-up.

**Org deletion:** `help_article.org_id` / `help_image.org_id` cascade on org delete (spec
0012). Ordinary org deletion removes only that org's own (unshared) help. But the shared,
global content lives in the platform owner's org, so deleting *that* org would remove the
shared help from every org's view — the platform owner's org is not a normal deletion target;
document it and warn if org-delete UI ever targets it.

**Styling:** navy/red AW, Tailwind v4, matching the existing drawer/rail, `ConfirmDialog`,
and settings sections. Tiptap and the sanitizer load only in the admin editor bundle, not
for readers.

**CSP:** no change needed — Tiptap is bundled (`script-src 'self'`), and images are served
same-origin from `/help/images/*` (`img-src 'self'`).

**Migrations:** two additive `CREATE TABLE`s (leaf tables) — no parent rebuild, safe on D1.

## Build plan (thin end-to-end read path first, then authoring)

1. **Migration**: `help_article` + `help_image` (additive leaf tables). *(AC-10)*
2. **Server layer + its isolation test**: `orgDb().help` CRUD + `listForReader()` union +
   the DOM-free sanitizer + audit; add to the `no-db-bypass` allowlist. Write the
   `listForReader` isolation test **now** (a non-shared org-A article never appears for org B),
   per spec 0012's convention of testing the guarded cross-org surface as it ships, not at the
   end. *(AC-4, AC-8, AC-10)*
3. **Read path end-to-end**: swap the header icon (remove bell, add `?`), build the Help
   drawer (search, contextual, contact link) + `GET /api/help`, seeded with one article.
   (The `pageKey` "For this page" list renders empty until app routes are retrofitted with
   keys — a known, harmless gap, tracked in Follow-up.) *(AC-1, AC-2, AC-4, AC-9)*
4. **`/help` full page** (routes by article id; slug cosmetic). *(AC-3)*
5. **Admin editor**: Tiptap + draft/publish/reorder + image upload (presigned R2, `help_image`
   row) + the **authorized** image serve. Reorder is last-write-wins on `sort_order`
   (acceptable; note it). *(AC-5, AC-7)*
6. **Platform-owner sharing**: the `shared` toggle (own-org write gated by `isPlatformOwner`) +
   the shared-image serve authorization + its cross-org isolation test. *(AC-6)*
7. **Remaining tests + `0024-verify.md`**: RBAC, sanitization (incl. `data:` rejection and
   script stripping), image cross-org authz, drawer behaviour.

## Consequences

- A real content surface staff can self-serve, maintained without a deploy.
- New attack surface (admin-authored HTML, uploaded images) — mitigated by sanitization,
  login-gated images, and RBAC; the audit log records edits.
- New client dependencies (Tiptap + a sanitizer) in the admin bundle only.

## Out of scope (later)

Article version history/rollback; comments; multi-language; server-side full-text search
(client-side is enough at this scale); per-article view analytics; the platform owner sharing
an article a *different* org authored (a cross-org promote/approve flow); org-owner-initiated
sharing with an approval step; embeds/tables beyond basic rich text.

## Follow-up

- Pick and pin the Tiptap packages and the **DOM-free** HTML sanitizer; confirm both bundle
  under `opennextjs-cloudflare build` (Workers runtime) **before** build step 2 depends on the
  sanitizer.
- Retrofit app routes with `pageKey`s so the drawer's "For this page" list populates (it ships
  empty until then).
- Set the support email address (config/env placeholder until provided).
- Decide the `pageKey` vocabulary (stable keys per app route) for contextual help.
- Confirm shared articles are editable only by their origin org, and how other orgs see
  attribution.
