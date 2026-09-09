# 0025 — Verification

**Built 2026-09-09.** The help CMS is now a full knowledge base: dedicated `(kb)` admin shell,
categories, tags, featured image, related articles, and per-article audience; the reader drawer
and `/help` group by category and filter by audience; the published article page matches
`mock-published-article.png` (breadcrumb, featured image, meta row, copy-able code blocks,
Article-details + Related rail).

## Automated checks (passing)

- `npx tsc --noEmit` — clean.
- `npx vitest run test/help.test.ts` — **10 passed**, covering:
  - **AC-4 / AC-9 (isolation):** a reader sees own-published ∪ shared-published, never drafts or
    another org's non-shared; `getForReader` honours the same union; the authorized image serve
    is own-org or referenced-by-shared only.
  - **AC-6 (audience):** a member never receives `admins` articles (list and get); an admin does.
  - **AC-2 (categories):** org-scoped; **delete reparents children to top-level and clears the
    category off articles** (`removeCategory`).
  - **AC-8 (category resolution + order):** the reader resolves an article's `category_id` to the
    category name (own org **and** cross-org for a shared article, join on id not org), falling
    back to the deprecated free-text `category`; the feed is returned in **curated `sort_order`**
    (0 first), not by recency.
  - **AC-5 (related):** `listRelatedForReader` resolves visible ids and drops dangling /
    not-visible ones.

## Behaviour fixed during verification

- **Reader ordering (AC-8):** the new `/help` card browser defaulted its sort to "Newest first",
  overriding the curated `sort_order`. Default is now **"Recommended order"** = `sort_order` asc
  (tie-broken by title); Newest / Oldest / A–Z remain as reader-chosen overrides. `sort_order` is
  now surfaced from `listForReader`.
- **Help drawer stuck on "Loading…":** the lazy-load effect cancelled its own in-flight fetch —
  it kept `loaded` in the dependency array and set it inside the effect, so starting the fetch
  re-ran the effect and its cleanup flipped the `alive` guard false before the response arrived.
  Rewritten to ref guards (`started`, `alive`), with `alive` reset to true on (re)mount so
  React StrictMode's double-mount no longer drops the result.

## Published article page (AC-7) — built to the mock

Breadcrumb (All help / category) → optional featured image (served through the authorized image
route, so a shared article's header resolves cross-org) → title → excerpt → meta row
(Published • date • Last updated) → divider → `.help-content` body with **copy-able code blocks**
→ rail (Article details: Category, Tags, Status, Visibility) + Related articles. Code-copy is a
client wrapper (`HelpArticleBody`) that injects a Copy button onto each `<pre>` at runtime — the
stored/served `body_html` stays static and sanitized (js-xss on save and again on render); nothing
is added to the HTML.

## Manual UI still to confirm in-browser

- **AC-1 (RBAC):** a plain member gets 404 at `/kb`; the top-nav "Knowledge base" entry is hidden
  for members. (Nav gating and the `requireOrgRole` layout are in place; confirm live.)
- **AC-7 render:** an article with a featured image, tags, related links, and a code block renders
  per the mock; the Copy button copies the code (not the button label) and shows "Copied".
- `/settings/help` redirects to `/kb`.

## Out of scope (unchanged from the spec)

Media library screen; nestable breadcrumb path across orgs (the published breadcrumb is the flat
resolved category name — cross-org safe); drag-and-drop category reordering; version history;
server-side full-text search.
