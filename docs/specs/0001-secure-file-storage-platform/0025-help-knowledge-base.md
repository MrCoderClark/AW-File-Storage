# 0025. Help knowledge base — dedicated CMS shell, categories, tags, featured images, related, audience

**Date**: 2026-09-08
**Status**: Built (see [0025-verify.md](0025-verify.md)) — pending in-browser UI confirmation

Extends [0024](0024-help-documentation-cms.md).

## Summary

Grow the help CMS (spec 0024) into a full **knowledge base** matching the design mocks
(`docs/Designs/mock-create-article.png`, `mock-published-article.png`). Move article authoring
**out of Settings** into a dedicated **Knowledge base** admin area with its own left-sidebar CMS
shell (admin/owner only). Add managed **categories** (a nestable tree), **tags**, an optional
**featured image**, **related articles**, and a per-article **audience** (all staff, or
admins-only). Upgrade the published article page to the mock: breadcrumb, title block, meta row,
typeset content with copy-able code blocks, and a details + related rail. The reader drawer and
`/help` from 0024 stay; their queries gain the audience filter and use categories. Everything is
**additive** on 0024's per-org + platform-owner-"shared" model and its isolation guarantees.

## Context

Spec 0024 shipped a working per-org help CMS: article authoring under **Settings → Help
articles**, the header `?` reader drawer + `/help` pages, per-org articles with a
platform-owner "shared" flag (the one cross-org read is `orgDb().help.listForReader`), private
R2 images served through an authorized route, and js-xss sanitization (needed because the app
CSP allows inline script, spec 0020). The user wants the richer knowledge-base look and the
authoring moved to its own admin area.

Current code this builds on: `src/components/help-admin.tsx` (the Tiptap editor),
`src/app/(app)/help/*` (reader pages), `src/app/(app)/settings/help` (the page being moved out),
`src/app/api/help/*` (routes), `orgDb().help` in `src/server/org-db.ts`, and the
`help_article` / `help_image` tables in `src/server/db/schema.ts`.

## Requirements

**User stories:**
- As an org admin/owner, I want a dedicated Knowledge base workspace (not buried in Settings) to
  write and organize help articles, matching our CMS mock.
- As an admin, I want to organize articles into categories (nestable), tag them, give them a
  featured image, and link related articles.
- As an admin, I want some articles visible to **all staff** and others to **admins only** (e.g.
  internal runbooks).
- As any staff member, I want the published articles to look polished (the mock), and to only
  see the ones meant for me.

**Acceptance criteria:**
- **AC-1 (dedicated admin area, CMS shell)**: Authoring moves out of Settings to a top-level
  **Knowledge base** area (route group `(kb)`, e.g. `/kb`), **admin/owner only** (members get
  404). It renders its **own left-sidebar CMS shell** — Overview, Articles, Categories, plus the
  category tree — with breadcrumbs, matching the mock, distinct from the app's normal top nav. A
  top-nav **Knowledge base** entry (shown only to admins/owners) links to it. The old
  `Settings → Help articles` page and nav entry are removed; `/settings/help` redirects to `/kb`.
- **AC-2 (categories)**: A managed `help_category` entity per org — create, rename, reorder, and
  **nest** (a parent). Each article may belong to one category. The CMS left tree and the reader
  grouping use it. Category management is admin/owner, org-scoped through `orgDb`.
- **AC-3 (tags)**: Free-form tags per article (chip input in the editor rail; shown on the
  published article). Stored as a JSON string array on the article; no join table.
- **AC-4 (featured image)**: An optional header image per article, uploaded to the private R2
  bucket (reusing the image pipeline), shown atop the published article, served through the same
  authorized route (own-org, or referenced by a published+shared article).
- **AC-5 (related articles)**: An admin picks related articles (same org) shown in the published
  right rail. Stored as a JSON array of article ids; dangling ids are ignored at render.
- **AC-6 (audience)**: A per-article **audience** — `all` (default; every signed-in staff member
  who can see the article) or `admins` (admins/owners only). Members never receive `admins`
  articles: the reader queries (`listForReader`, `getForReader`) filter by the caller's role,
  server-side. Audience is independent of the platform-owner `shared` flag (which controls
  cross-org visibility, not role).
- **AC-7 (published page to the mock)**: breadcrumb (category path) → featured image (if set) →
  title → excerpt subtitle → meta row (Published • date • Last updated) → a divider → typeset
  content with **copy-able code blocks** → a right rail (Article details: category, tags, status,
  audience, updated; and Related articles). Wide, left-aligned (the 0025 layout on top of 0024's
  `.help-content` typography).
- **AC-8 (reader integration)**: The header `?` drawer and `/help` (spec 0024) keep working;
  their reader query filters by audience (a member never sees `admins` articles) and groups by
  category. The upgraded page is the article view for both.
- **AC-9 (isolation, authz, security)**: Categories, tags, featured image, and related links are
  all per-org through `orgDb`; writes stay org-scoped. The **only** cross-org reads remain
  `listForReader` and the authorized image serve (now also resolving a shared article's category
  name + featured image) — documented and isolation-tested. Authoring is admin/owner; the
  `shared` flag stays platform-owner-only; the `audience` filter is enforced server-side. Body
  HTML is sanitized with js-xss. **All migrations are additive** (a new `help_category` table +
  new columns on `help_article`; no parent-table rebuild — gotcha #9).

## Decision

**Chosen approach**: build the dedicated **CMS shell** the user asked for as a new `(kb)` route
group with its own left-sidebar layout (admin/owner gated), reusing the existing Tiptap editor
and the 0024 server layer. **Categories** are a per-org nestable entity (`help_category`); **tags**
and **related ids** are JSON arrays on the article (no join tables — right-sized for this scale);
the **featured image** is a `featured_image_id` pointing at `help_image`; **audience** is an enum
column filtered by role in the reader queries. The published page is upgraded to the mock on top
of 0024's `.help-content` typography, with code-copy added by a client wrapper (never by
injecting HTML). The reader drawer/`/help` gain the audience filter and category grouping.

**Rejected**: keeping authoring in Settings (the user wants it out); a full pixel clone of the
mock's own nav including Media/Users (Media deferred; Users/Settings already exist in the app);
join tables for tags/related (overkill at this scale); a media library (deferred). Cloning the
mock's *shell* is in; cloning its every nav item is not.

**Implementation skills**: `tailwindcss-v4`, `frontend-design` (the CMS shell + published page are
real UI design work, built to the two mocks).

## Feature design

**Data model** (additive; `organization`/parents never rebuilt — gotcha #9):

| Table | Change | Notes |
|---|---|---|
| `help_category` | **new**: `id`, `org_id` (FK cascade), `name`, `slug`, `parent_id` (nullable self-FK, `set null` on delete), `sort_order`, `created_at`, `updated_at` | The nestable category tree. Index `(org_id, parent_id, sort_order)`. Per-org. |
| `help_article` | `+ category_id` (FK `help_category`, nullable, `set null`) | Replaces the free-text `category` going forward; the old `category` column is kept (deprecated, used only for 0024 rows with no `category_id`). |
| `help_article` | `+ tags` text (JSON array, default `'[]'`) | Chip tags. |
| `help_article` | `+ featured_image_id` (FK `help_image`, nullable, `set null`) | The header image. |
| `help_article` | `+ related_ids` text (JSON array, default `'[]'`) | Same-org related article ids; dangling ignored on render. |
| `help_article` | `+ audience` text (`all` / `admins`, default `all`) | Role gate for readers. |

**The cross-org reads stay two, and stay documented** (spec 0024 AC-10): `listForReader`
(own-org published ∪ shared published, now **also** filtered by audience for the caller's role,
and resolving the category name + featured image url so a shared article renders fully in another
org) and the authorized image serve. No new cross-org write. The `no-db-bypass` allowlist and the
isolation test are extended, not loosened.

**The Knowledge base shell** (`src/app/(kb)/…` with its own `layout.tsx`):
- `layout.tsx` gates `requireOrgRole("admin")` and renders the CMS chrome: a left sidebar (brand
  header, nav: Overview, Articles, Categories, and the live category tree), a top bar with search
  + the user menu, and breadcrumbs. Navy/red AW styling, Tailwind v4, responsive (sidebar becomes
  a drawer below `lg`). `export const dynamic = "force-dynamic"`.
- Pages: `/kb` (overview: counts, recent), `/kb/articles` (list with status/category/audience),
  `/kb/articles/new` and `/kb/articles/[id]` (the editor), `/kb/categories` (manage the tree).
- **Editor** (refactor `help-admin.tsx` into the shell): Tiptap body (existing toolbar + code
  block), Save Draft / Publish in the header, and the right **Article details** rail — Category
  (select from the org's categories), Tags (chip input), Status, Audience (all/admins), Featured
  image (dropzone → `/api/help/images`), Related articles (search + pick, same org), and the
  platform-owner Share toggle. Breadcrumbs (Articles → New/Edit).
- **Top nav**: add a **Knowledge base** entry in `app-nav`/`app-header`, visible only when the
  caller is admin/owner (from `getActor().role`). Remove the `Settings → Help articles` entry;
  redirect `/settings/help` → `/kb`.

**API** (extend 0024, all admin/owner + org-scoped unless noted):
- `POST`/`PATCH /api/help/articles[/id]` accept `categoryId`, `tags`, `featuredImageId`,
  `relatedIds`, `audience` (the `shared` flag stays platform-owner-only).
- **New** `/api/help/categories` (GET list, POST create) and `/api/help/categories/[id]`
  (PATCH rename/reparent/reorder, DELETE — children reparent to null, articles' `category_id` set
  null).
- Featured image reuses `POST /api/help/images` + the authorized `GET /api/help/images/[id]`.
- Reader `GET /api/help` + `listForReader` gain the audience filter and return category + featured.

**Published article page** (`src/app/(app)/help/[id]`): the mock layout — breadcrumb (category
path), featured image header, title, excerpt, meta row + divider, `.help-content` body, a right
rail (Article details + Related articles). **Code-copy** is added by a small client component that
wraps the rendered article and injects copy buttons onto `<pre>` blocks at runtime (the stored
HTML stays static and sanitized; nothing is added to `body_html`).

**Reader drawer + `/help`** (spec 0024): keep, but group by category and filter by audience
(members never see `admins` articles).

**Security**: unchanged posture — js-xss sanitize on save + render; images authorized-serve;
authoring RBAC server-enforced; sharing platform-owner-only; audience enforced server-side; every
write org-scoped; the two cross-org reads documented + isolation-tested.

## Build plan (additive migration first, then the shell, then the polish)

1. **Migration**: `help_category` + the additive `help_article` columns
   (`category_id`, `tags`, `featured_image_id`, `related_ids`, `audience`). *(AC-2..6, AC-9)*
2. **Server layer + isolation tests**: `orgDb().help` category CRUD; article fields; the audience
   filter in `listForReader`/`getForReader`; category-name/featured resolution for shared reads.
   Extend the isolation test (admins-only hidden from members; a non-shared category/article never
   crosses orgs) and the `no-db-bypass` note. *(AC-6, AC-9)*
3. **KB shell + IA move**: the `(kb)` route group + CMS layout (left nav, category tree,
   breadcrumbs), the top-nav Knowledge base entry (admin/owner), and the `/settings/help` →
   `/kb` redirect; port the editor into `/kb/articles/[id]` with the full details rail
   (category/tags/audience/featured/related/share). *(AC-1, AC-3..6)*
4. **Categories page**: `/kb/categories` — create/rename/reorder/nest. *(AC-2)*
5. **Published page upgrade**: the mock layout + featured image + related rail + code-copy. *(AC-7)*
6. **Reader integration**: drawer + `/help` grouped by category, audience-filtered. *(AC-8)*
7. **Tests + `0025-verify.md`**: RBAC (member can't reach `/kb`; member can't see `admins`
   articles), category CRUD + reparent-on-delete, tags/related round-trip, featured image
   authorized-serve, published layout, isolation.

## Consequences

A genuine knowledge base that matches the mocks. Costs: a second app shell (the `(kb)` area) and
more surface (categories, tags, featured, related, audience) to maintain; a slightly richer
article read query. All additive and within the existing isolation model, so no data risk.

## Out of scope (later)

A Media library screen; category-level sharing/permissions; article version history/rollback;
server-side full-text search; per-tag browse pages; drag-and-drop tree reordering (a `sort_order`
field is enough for now); rich embeds beyond images/code.

## Follow-up

- Confirm the code-copy client wrapper approach bundles cleanly and stays accessible.
- Decide whether a shared article's category should be attributed to its origin org in other orgs'
  reader nav, or shown flat.
- Drag-and-drop category reordering (uses the `sort_order` field) as a later polish.
- Retrofit app routes with `pageKey`s (carried over from spec 0024) so the drawer's "For this
  page" list populates.
