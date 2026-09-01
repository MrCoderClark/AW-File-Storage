# 0007. Files view: browse, search, and manage all files

**Date**: 2026-08-29

## Summary

The only way to see stored files today is the small list under the uploader on the Upload Center. This spec adds a dedicated **Files** page (`docs/Designs/mock-files.jpg`): every live file for the organization in a sortable table — name with a type icon, size, last modified, who uploaded it, and per-row actions (copy link, download, rename, unpublish, delete) — plus a **search** box and a **filter by type**, a count in the title, and multi-select for bulk delete. The header's existing "Search files" box is wired to it. Folders (the mock's "New Folder") are deferred — the data model has no folder concept.

**Inline rationale.** The list, the actions, and the org-scoped query already exist (spec 0004's `FileManager` + `GET /api/files` + the file action routes); this spec promotes them into a first-class page and adds the columns and controls the mock shows. Search and filter run client-side over the org's file list — at current volume that is simpler and instant, and the list already loads in full; a server search endpoint can replace it later without changing the page.

## Requirements

**Acceptance criteria**:
- **AC-1**: A **Files** tab in the primary navigation opens `/files`, showing all live (non-deleted) files for the active organization in a table: Name (+ type icon), Size, Last Modified, Uploaded By, Status, Actions. The title shows the count.
- **AC-2**: A search box filters the list by file name as you type. The header "Search files" box navigates to `/files?q=…` and seeds the search.
- **AC-3**: A "Filter by type" control narrows the list by category (Contact card, PDF, Image, Document, Archive, Other), derived from the file's name/content type.
- **AC-4**: Per-row actions, gated by permission (`canManage`): **Rename** (edits the display name), **Copy link** (published cards), **Download** (private files, via a signed link), **Unpublish** (published cards), **Delete**. The server re-checks permission on every action.
- **AC-5**: Rows are multi-selectable (with a select-all), and selected files can be **deleted in bulk** with one confirmation naming the count. Only files the caller may manage are actually deleted.
- **AC-6**: The view has a loading skeleton, an empty state ("No files yet" / "No files match"), and an error state with retry. It refreshes after any action.
- **AC-7**: Every query is org-scoped from the session (spec 0002); Uploaded By is resolved by joining `file.uploaded_by` → `user`. Renaming and deleting each write one audit row.
- **AC-8**: The table is responsive: it scrolls horizontally inside its own container on narrow screens; the page body never scrolls sideways.

## Decision

**Chosen option**: A dedicated `/files` page + a `FilesView` client component. Reuse the existing action routes; add `PATCH /api/files/[id]` for rename and enrich `listFiles` with the uploader name, content type, and last-modified. Search + type filter are client-side *(superseded — moved server-side; see Follow-up below)*. **Folders and "New Folder" are out of scope** (no folder concept in the data model; its own migration + upload-path change later). The Upload Center keeps the uploader; its inline file list is superseded by this page.

**Implementation skills**: `tailwindcss-v4` · `frontend-design`.

## Feature design

**Server**:
- `listFiles` (in `uploads.ts`) enriched to return `uploadedByName`, `contentType`, and `updatedAt` (last modified), via a `file` ⨝ `user` join with an explicit `org_id` filter, still newest-first, soft-deleted excluded.
- `renameFile(env, actor, id, name)` — org-scoped, `canManage`, updates `original_name`, writes `file.renamed` audit. `PATCH /api/files/[id]` calls it.
- Existing routes reused: `POST /api/files/[id]/link` (download), `POST /api/files/[id]/unpublish`, `DELETE /api/files/[id]`.

**Type category** (for icon + filter) derived from the extension / content type: `vcard` → Contact card; `pdf`; `image` (png/jpg/gif/webp/svg); `document` (doc/docx/txt/rtf/xls/xlsx/ppt/pptx); `archive` (zip/rar/7z/gz/tar); else `other`.

**UI**: `/files` page → `FilesView`. Toolbar: search input, type filter, and an "Upload files" link to `/upload-center` (no "New Folder"). Table with a select column, the mock's columns, and a row action menu. Bulk-delete bar appears when rows are selected. Reads `?q=` on load.

**Key invariants**:
1. The page never shows an action the caller's role can't use (`canManage`); the server re-checks.
2. Search/filter are display-only over the org's own files; they never reach another org's data.

**Critical test scenarios**:
- The type-category helper maps representative names/content types correctly.
- Rename changes `original_name`, is org-scoped, and audits.

## Build plan

1. Enrich `listFiles` (uploader name, content type, updated-at) + the type-category helper.
2. `renameFile` service + `PATCH /api/files/[id]`.
3. `/files` page + nav tab + `FilesView` (table, search, filter, count, states).
4. Per-row actions (rename, copy, download, unpublish, delete) + multi-select bulk delete.
5. Wire the header "Search files" box to `/files?q=`.
6. Tests for the category helper and `renameFile`.

## Follow-up — server-side pagination, search & filtering (2026-09-01, PR #25)

The original AC-2/AC-3 client-side approach (load all rows, filter in memory) was replaced before it became a scale problem, and to make **contact content** searchable — the searchable fields (company, title, email) live inside the `.vcf` in R2, not the DB, so filename-only search couldn't find them.

- **Data model:** new `file` columns `contact_name/org/title/email` (denormalised from the vCard at finalize via `parseVcard`) + a persisted `category` (`fileCategory`), with composite keyset indexes. Additive **migration 0008** (5 `ADD COLUMN` + 6 `CREATE INDEX`, no table rebuild). Existing rows filled once by owner-only `POST /api/admin/backfill-search` (idempotent).
- **Query:** `listFilesPage(env, ctx, opts)` in `uploads.ts` — **keyset (cursor) pagination** ordering by `(sortColumn, id)` with an opaque base64 `[sortValue, id]` cursor (no OFFSET → stable under inserts/deletes); server-side `LIKE` search over filename + the contact fields + uploader name; `category`/`kind`/`status` equality filters; Name/Size/Modified/Newest sorts. `encodeCursor`/`decodeCursor` helpers. `listFiles` removed (only the route used it).
- **API:** `GET /api/files` now takes `q/category/kind/status/sort/dir/cursor/limit` and returns `{ items, nextCursor }`.
- **UI:** `/files/page.tsx` server-renders the first page (default 30 rows); `FilesView` does debounced+abortable search, **Load more**, sortable headers, and syncs `q/category/sort/dir` to the URL. Client-side filtering removed.
- **Deferred:** SQLite **FTS5** over the same columns (chosen against for now — stays in Drizzle's additive-migration model; revisit past ~10k cards/org). Numbered pagination was rejected — it needs OFFSET, which keyset deliberately avoids; **Next/Prev** (still keyset) is the fallback if the growing DOM from Load more becomes an issue.
- Tests: `test/files-list.test.ts` (pagination, keyset-vs-offset stability, sorts, search, filters, org-scoping).

### Location search — city & state (migration 0009)

Search was extended to cover **city and state**. A `file.contact_location` column holds a searchable `"City Abbr FullName"` blob (e.g. `"Bronx NY New York"`) built by `buildLocationText` (`signature-brand.ts`), so one `LIKE` matches the city or either state form (`NY` *and* `New York`) — no query-time expansion. Populated at publish/edit; `backfillSearchFields` re-fills rows that predate the column. Added to the `listFilesPage` search `OR`. Additive migration 0009; a prod backfill re-run is needed after deploy.
