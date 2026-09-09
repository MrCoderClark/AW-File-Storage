# 0026. Help media library — a reusable image library, client-side downscaling, and in-article image resizing

**Date**: 2026-09-09
**Status**: Built — pending migration apply + in-browser UI confirmation

Extends [0025](0025-help-knowledge-base.md) (which extends [0024](0024-help-documentation-cms.md)).

## Summary

Turn the help CMS's per-article image handling into a real **media library**. Add a
**Knowledge base → Media** screen where an admin browses every image the org has uploaded,
reuses one in an article or as a featured image, renames it, edits its alt text, and deletes it
(blocked while an article still uses it). On upload, images are **downscaled and re-encoded in the
browser** before they reach R2, so a huge screenshot never bloats storage or the article. In the
editor, an author can **resize an image** two ways — drag a corner handle, or pick a preset
(Small / Medium / Full) and an alignment — with the size stored as a plain `width` attribute the
sanitizer already allows. Everything is **additive** on 0024/0025's private-R2 + authorized-serve
pipeline and the per-org + platform-owner-"shared" isolation model; no image leaves R2 and no new
outside origin is introduced (the enforced CSP is untouched).

## Context

Spec 0024 shipped help images: a browser uploads straight to the **private** R2 bucket via a
presigned `PUT`, and images serve back through an **authorized** Next route
(`GET /api/help/images/[id]` — own-org, or referenced by a published + shared article). Spec 0025
added a featured image per article (`help_article.featured_image_id`, a logical reference to
`help_image`). The `help_image` row records `org_id`, a nullable `article_id` (FK, `cascade` on
delete), `r2_key`, `content_type`, `uploaded_by`, `created_at`. The Tiptap editor inserts body
images and sets the featured image; the reader renders body HTML (sanitized with js-xss, which
already whitelists `img` `src`/`alt`/`width`/`height`) plus the featured image header.

Two gaps the user hit: (1) there is no way to **see or reuse** the images an org has already
uploaded — every insert re-uploads, and orphaned images pile up invisibly; (2) images go in at
full resolution and there is **no way to size them** in the article, so large images look wrong.
The user asked for a Media library screen and image resizing "so the images look good".

Current code this builds on: `help_image` in `src/server/db/schema.ts`; `orgDb().help` image
methods (`createImage`, `linkImages`, `getServableImage`) in `src/server/org-db.ts`; the image
routes under `src/app/api/help/images/`; the editor `src/components/kb/article-editor.tsx`; the
KB shell + pages under `src/app/kb/`; the sanitizer `src/server/help-sanitize.ts`; the reader
`.help-content` typography in `src/app/globals.css`.

## Requirements

**User stories:**
- As an org admin, I want a Media screen in the Knowledge base to see every image we've uploaded,
  so I can reuse one instead of re-uploading and clean up ones we no longer use.
- As an author, I want to reuse a library image in an article body or as the featured image, and
  to rename an image and give it alt text.
- As an author, I want to resize an image in the article — drag to size, or pick Small / Medium /
  Full and an alignment — so it looks right on the page.
- As an admin, I want big images to be shrunk automatically on upload so articles stay fast and
  tidy, without thinking about it.
- As an admin, I want deleting an in-use image to be prevented (and to be told where it's used),
  so I never break a published article by accident.

**Acceptance criteria:**
- **AC-1 (Media library screen)**: a new **`/kb/media`** page (admin/owner only, inside the KB
  shell) shows this org's images as a grid of thumbnails (served through the existing authorized
  route), each with its name, dimensions, file size, and a **Used / Unused** badge. Upload
  (drag-and-drop or picker), rename, edit alt text, and delete are all available here. Org-scoped
  through `orgDb`.
- **AC-2 (client-side downscale on upload)**: before the presigned `PUT`, an image is downscaled
  in the browser to a max dimension (default **1600px** on the longest side) and re-encoded
  (WebP when supported, else JPEG, at a good quality) when it exceeds that or a size threshold;
  smaller images pass through untouched. The stored `help_image` row records the final
  `width`, `height`, and `size_bytes`. Applies to both body-image and featured-image uploads.
- **AC-3 (reuse from the library)**: in the editor, "insert image" and "set featured image" both
  offer a **library picker** (the same grid) to choose an existing image, as well as uploading a
  new one. Inserting places the image by its authorized-serve URL; the featured image sets
  `featured_image_id`. Reuse never re-uploads bytes.
- **AC-4 (rename + alt text)**: each image has an editable **display name** (`filename`) and
  **alt text** (`alt_text`). Alt text is applied to the `alt` attribute on insert and on the
  featured image, for accessibility. Both editable from the Media screen (and the picker).
- **AC-5 (in-article resize — both handles and presets)**: selecting a body image shows a small
  toolbar with **Small / Medium / Full** size presets and **left / center / right** alignment,
  and a **drag handle** on the corner to set an arbitrary width. The size is stored as a numeric
  **`width`** attribute (px; Full clears it to flow at column width) and alignment as a
  **`data-align`** attribute — both sanitizer-whitelisted, never inline `style`. Images stay
  responsive (`max-width:100%`) at every size.
- **AC-6 (delete blocked while in use)**: deleting an image is **refused** while any of the org's
  articles reference it — in a body (its serve URL/id appears in `body_html`) or as
  `featured_image_id` — and the response **lists the referencing articles** so the admin can
  unlink first. An **Unused** image deletes cleanly (row + R2 object).
- **AC-7 (isolation, authz, security)**: the library, rename, alt, resize metadata, and delete are
  all per-org through `orgDb`; writes stay org-scoped. The only cross-org read stays the
  authorized image serve (own-org, or referenced by a published + shared article) — unchanged and
  isolation-tested. Authoring is admin/owner (`requireApiRole`/`requireOrgRole`). Body HTML stays
  js-xss sanitized with **no new attribute that carries a URL or script** (`width`/`height`
  already allowed; `data-align` is an enum). **All migrations are additive** — new nullable
  columns on `help_image`, no parent-table rebuild (gotcha #9).

## Decision

**Chosen approach**:

- **Resize pipeline — client-side, before upload.** Downscale + re-encode in the browser with a
  canvas (`createImageBitmap` → `OffscreenCanvas`/`<canvas>` → `toBlob`), then presign-`PUT` the
  smaller blob exactly as today. No server-side image processing (native libs like `sharp` don't
  run on Workers), no Cloudflare Images (a separate store on a new `imagedelivery.net` origin the
  enforced CSP would have to allow, with its own signed-URL access), no zone-level Image Resizing
  (paid, and awkward for private auth-routed images). This keeps the whole R2 + authorized-serve
  pipeline intact, adds zero infra/cost, and is what actually makes images "look good" by default.
- **In-article sizing — a `width` attribute, driven by both a drag handle and presets.** A Tiptap
  image NodeView adds a corner drag handle and a floating toolbar (Small ≈ 320px / Medium ≈ 560px
  / Full = no width, flows to the column) plus alignment. Size is a numeric `width` attribute
  (already sanitizer-allowed); alignment is a `data-align` enum. No inline `style` (keeps the
  sanitizer surface flat). Rendered responsive in `.help-content`.
- **Library model — additive, reference-counted, no cascade surprise.** New nullable columns on
  `help_image` (`filename`, `alt_text`, `width`, `height`, `size_bytes`). New uploads are
  **library-owned** (`article_id = null`) rather than bound to one article, so an image can be
  reused across articles and the old `article_id` `cascade`-on-delete never wipes a shared image;
  legacy rows keep their `article_id` harmlessly. **"In use"** is computed by a reference scan —
  the image id/serve URL appearing in any of the org's `body_html`, or as any article's
  `featured_image_id` — which also powers the delete guard and the Used/Unused badge.

**Rejected**: Cloudflare Images / zone Image Resizing (new origin + CSP change + cost + private-image
signing, overkill for a help CMS — kept as a future option for responsive variants); server-side
resize on Workers (`sharp` unsupported); inline-`style` widths (needless sanitizer risk when a
numeric `width` is already allowed); a rebuild of `help_image` to drop the `article_id` cascade
(unnecessary — library-owned rows use `article_id = null`, keeping the migration additive per
gotcha #9); a separate `media`/join table for reuse (the reference scan is right-sized at this
scale).

**Implementation skills**: `tailwindcss-v4` and `frontend-design` (the Media grid, the picker, and
the in-editor resize toolbar are real UI work); Tiptap NodeView work for the resize handle.

## Feature design

**Data model** (additive; `help_image` gains nullable columns, no rebuild — gotcha #9):

| Table | Change | Notes |
|---|---|---|
| `help_image` | `+ filename` text (nullable) | Editable display name; defaults to the original file name on upload. |
| `help_image` | `+ alt_text` text (nullable) | Applied to `alt` on insert and on the featured image. |
| `help_image` | `+ width` / `+ height` integer (nullable) | Intrinsic pixel size after client downscale, captured on upload. |
| `help_image` | `+ size_bytes` integer (nullable) | Final stored byte size, for the library display. |

New uploads set `article_id = null` (library-owned). `getServableImage` is unchanged. The one
cross-org read stays the authorized serve; the library list, metadata edits, and delete are all
own-org only.

**Server layer** (`orgDb().help`, org-scoped):
- `listImages()` — this org's images (id, filename, contentType, width, height, sizeBytes,
  createdAt), newest first, each annotated with `inUse` from the reference scan.
- `referencedImageIds()` — the set of image ids referenced by any of this org's articles: ids
  whose serve URL/id appears in a `body_html`, unioned with all non-null `featured_image_id`.
  Backs `inUse` and the delete guard.
- `updateImage(id, { filename?, altText? })` — org-scoped rename / alt edit.
- `deleteImage(id)` — refuses (returns the referencing articles) when the id is in
  `referencedImageIds()`; otherwise deletes the row and the R2 object.
- `createImage` — extended to persist `filename`, `width`, `height`, `sizeBytes`; `article_id`
  defaults to null for library-owned uploads. `linkImages` is retained for legacy call sites but
  no longer required for reuse.

**Client resize utility** (`src/lib/image-resize.ts`, browser-only): `resizeImageForUpload(file,
{ maxEdge = 1600, quality })` → `{ blob, width, height, type }`. Decodes with
`createImageBitmap`, draws to a canvas at the capped size, encodes to WebP (feature-detected) or
JPEG; passes through images already within bounds. The upload flow sends the resulting
`width`/`height`/`size` to the reserve call so the row is complete.

**Tiptap image resize** (editor): extend the image node with `width` and `data-align` attributes
and a NodeView that renders a selected-state toolbar (S / M / Full + align) and a corner drag
handle updating `width` live. The sanitizer whitelist gains `data-align` on `img` (enum
left/center/right); `width`/`height` are already allowed; inline `style` stays disallowed.
`.help-content img` gets alignment + responsive rules (`width` attribute honoured, `max-width:100%`
always).

**Media library screen** (`/kb/media`, in the KB shell, admin/owner): a responsive thumbnail grid
(images via the authorized route) with upload (drag-drop, auto-downscaled), and per-image rename,
alt-text edit, Used/Unused badge, and delete (disabled/blocked with a "used in N articles" list
when in use). A shared **MediaPicker** component powers both this page's management view and the
editor's "insert image" / "set featured image" flows (browse existing + upload new).

**API** (extend 0024/0025, all admin/owner + org-scoped unless noted):
- `GET /api/help/images` — **new**: list the org's library (with `inUse`).
- `PATCH /api/help/images/[id]` — **new**: rename / edit alt text.
- `DELETE /api/help/images/[id]` — **new**: delete, `409` with the referencing articles when in use.
- `POST /api/help/images` — **extended**: accept `filename`, `width`, `height`, `size` on reserve.
- `GET /api/help/images/[id]` — **unchanged** authorized serve.

**Security**: unchanged posture — private R2, authorized serve, js-xss sanitize on save + render,
authoring RBAC server-enforced, every write org-scoped, the one cross-org read documented +
isolation-tested. No new outside origin, so the enforced CSP (spec 0020) is untouched. The new
`data-align` attribute is an enum (no URL/script surface).

## Build plan (additive migration first, then server, then the UI slices)

1. **Migration**: additive nullable columns on `help_image` (`filename`, `alt_text`, `width`,
   `height`, `size_bytes`). Inspect the generated SQL for any parent rebuild before applying
   (gotcha #9); expect a plain `ALTER TABLE ADD COLUMN` set. *(AC-1..4, AC-7)*
2. **Server layer + isolation tests**: `listImages`, `referencedImageIds`, `updateImage`,
   `deleteImage` (in-use guard), extended `createImage`. Extend the isolation test (another org's
   image never lists/edits/deletes cross-org; the in-use guard blocks a referenced delete and
   allows an orphan). *(AC-1, AC-4, AC-6, AC-7)*
3. **Client downscale + upload wiring**: `image-resize.ts`; wire into the editor's body-image and
   featured-image uploads so new images are downscaled and their dimensions/size recorded. *(AC-2)*
4. **In-article resize**: the Tiptap `width`/`data-align` attributes + NodeView (drag handle +
   S/M/Full + align), sanitizer `data-align`, and `.help-content` CSS. *(AC-5)*
5. **Media library screen + picker**: `/kb/media` grid (upload/rename/alt/delete + Used/Unused)
   and the shared MediaPicker; wire the picker into "insert image" and "set featured image". *(AC-1, AC-3, AC-4, AC-6)*
6. **Tests + `0026-verify.md`**: RBAC (member can't reach `/kb/media` or the write routes),
   downscale (an oversized image is stored within bounds with recorded dimensions), reuse without
   re-upload, resize round-trip (width/align persist and re-render sanitized), delete-in-use
   blocked with references / orphan deletes, isolation. *(all AC)*

## Consequences

A genuine media library: reuse, cleanup, accessible alt text, and images that look right at any
size — with faster articles because uploads are downscaled by default. Costs: a new screen +
picker, a client resize path (canvas encoding differs slightly across browsers), a Tiptap NodeView
to maintain, and a reference scan on the library list and on delete (bounded by an org's article
count; index-friendly and cheap at this scale). All additive and inside the existing isolation
model, so no data risk.

## Out of scope (later)

Responsive/multiple variants or thumbnails via Cloudflare Images or zone Image Resizing (revisit if
article images ever need art-directed sizes); a background orphan-sweep cron (the Unused badge +
manual delete cover it for now); cropping/rotation/editing; drag-resize on touch devices (presets
cover touch); non-image media (PDF/video); tagging or folders in the library; deduplicating
identical uploads by content hash.

## Follow-up

- Confirm the canvas re-encode (WebP feature-detect, quality) looks good across the browsers AW
  staff use, and that EXIF orientation is respected on downscale.
- Decide a default max edge (1600px assumed) and JPEG/WebP quality after eyeballing real uploads.
- Consider a periodic orphan sweep (cron) once the library has real volume.
- If richer sizing is ever needed, revisit Cloudflare Images for server-generated variants (would
  add an origin to the enforced CSP).
