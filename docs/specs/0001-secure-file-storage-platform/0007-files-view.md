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

**Chosen option**: A dedicated `/files` page + a `FilesView` client component. Reuse the existing action routes; add `PATCH /api/files/[id]` for rename and enrich `listFiles` with the uploader name, content type, and last-modified. Search + type filter are client-side. **Folders and "New Folder" are out of scope** (no folder concept in the data model; its own migration + upload-path change later). The Upload Center keeps the uploader; its inline file list is superseded by this page.

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
