"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAppData } from "@/components/app-data";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  CATEGORY_LABEL,
  type FileCategory,
  fileCategory,
} from "@/lib/file-type";
import { formatBytes, timeAgo } from "@/lib/format";

// The wire shape of a file row: the server's FileListItem with its dates
// serialized to ISO strings (so the RSC-seeded first page and the API's
// load-more pages are identical).
export interface SerializedFile {
  id: string;
  name: string;
  kind: "vcard" | "other";
  status: string;
  visibility: "private" | "public";
  sizeBytes: number;
  contentType: string;
  publicUrl?: string;
  // Same-origin path to the public landing page for a published card (spec 0008),
  // e.g. "/c/Jane_Doe"; undefined for private/non-vCard rows.
  landingUrl?: string;
  uploadedByName: string;
  contactName: string | null;
  contactOrg: string | null;
  createdAt: string;
  updatedAt: string;
  canManage: boolean;
  // Public-landing engagement (spec 0008): view/scan/download totals for a
  // published card, or null for private/non-vCard rows with no public page.
  stats: {
    views: number;
    scans: number;
    downloads: number;
    lastActivity: string | null;
  } | null;
}

type Sort = "new" | "name" | "size" | "modified";
type Dir = "asc" | "desc";

const CATEGORIES: FileCategory[] = [
  "vcard",
  "pdf",
  "image",
  "document",
  "archive",
  "other",
];

const SEARCH_DEBOUNCE_MS = 300;

export function FilesView({
  initialItems,
  initialCursor,
  initialQuery = "",
  initialCategory = "all",
  initialSort = "new",
  initialDir = "desc",
}: {
  initialItems: SerializedFile[];
  initialCursor: string | null;
  initialQuery?: string;
  initialCategory?: "all" | FileCategory;
  initialSort?: Sort;
  initialDir?: Dir;
}) {
  const { refresh } = useAppData();
  const router = useRouter();
  const pathname = usePathname();

  const [items, setItems] = useState<SerializedFile[]>(initialItems);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [search, setSearch] = useState(initialQuery); // the live input value
  const [query, setQuery] = useState(initialQuery); // debounced, drives fetches
  const [category, setCategory] = useState<"all" | FileCategory>(initialCategory);
  const [sort, setSort] = useState<Sort>(initialSort);
  const [dir, setDir] = useState<Dir>(initialDir);
  const [phase, setPhase] = useState<
    "idle" | "loading" | "loadingMore" | "error"
  >("idle");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkDialog, setBulkDialog] = useState(false);

  const firstRender = useRef(true);
  const abortRef = useRef<AbortController | null>(null);

  // Build the query string for the current filter/sort (and an optional cursor).
  const buildParams = useCallback(
    (nextCursor?: string) => {
      const p = new URLSearchParams();
      const q = query.trim();
      if (q) p.set("q", q);
      if (category !== "all") p.set("category", category);
      if (sort !== "new") p.set("sort", sort);
      if (dir !== "desc") p.set("dir", dir);
      if (nextCursor) p.set("cursor", nextCursor);
      return p;
    },
    [query, category, sort, dir],
  );

  // Debounce the search box into `query`.
  useEffect(() => {
    if (search === query) return;
    const t = setTimeout(() => setQuery(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search, query]);

  // Fetch the first page whenever the query/filter/sort changes — and keep those
  // in the URL so a view is shareable and the back button works. Skips the very
  // first render (the server already provided that page).
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const params = buildParams();
    // Reflect state in the URL (without the ephemeral cursor).
    router.replace(`${pathname}${params.toString() ? `?${params}` : ""}`, {
      scroll: false,
    });

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setPhase("loading");
    void (async () => {
      try {
        const res = await fetch(`/api/files?${params}`, {
          cache: "no-store",
          signal: ac.signal,
        });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as {
          items: SerializedFile[];
          nextCursor: string | null;
        };
        setItems(body.items);
        setCursor(body.nextCursor);
        setSelected(new Set());
        setPhase("idle");
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setPhase("error");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, category, sort, dir]);

  const loadMore = useCallback(async () => {
    if (!cursor || phase === "loadingMore") return;
    setPhase("loadingMore");
    try {
      const res = await fetch(`/api/files?${buildParams(cursor)}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as {
        items: SerializedFile[];
        nextCursor: string | null;
      };
      setItems((prev) => [...prev, ...body.items]);
      setCursor(body.nextCursor);
      setPhase("idle");
    } catch {
      setPhase("error");
    }
  }, [cursor, phase, buildParams]);

  // Re-run the current query from the first page (after a mutation). Also
  // refreshes the rail (Storage Usage etc.).
  const reloadAll = useCallback(async () => {
    try {
      const res = await fetch(`/api/files?${buildParams()}`, {
        cache: "no-store",
      });
      if (res.ok) {
        const body = (await res.json()) as {
          items: SerializedFile[];
          nextCursor: string | null;
        };
        setItems(body.items);
        setCursor(body.nextCursor);
        setSelected(new Set());
      }
    } finally {
      refresh();
    }
  }, [buildParams, refresh]);

  const manageable = items.filter((f) => f.canManage);
  const allSelected =
    manageable.length > 0 && manageable.every((f) => selected.has(f.id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(manageable.map((f) => f.id)));
  }

  // Click a sortable header: toggle direction if it's the active sort, else
  // switch to it with a sensible default direction.
  function sortBy(next: Sort) {
    if (sort === next) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSort(next);
      setDir(next === "name" ? "asc" : "desc");
    }
  }

  async function bulkDelete() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      await Promise.all(
        ids.map((id) => fetch(`/api/files/${id}`, { method: "DELETE" })),
      );
      await reloadAll();
      setBulkDialog(false);
    } finally {
      setBulkBusy(false);
    }
  }

  const loading = phase === "loading";

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="text-2xl font-semibold text-brand-900">
        Files{" "}
        <span className="text-lg font-normal text-muted-500">
          ({items.length}
          {cursor ? "+" : ""})
        </span>
      </h1>

      {/* Toolbar */}
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <Link
          href="/upload-center"
          className="rounded-[--radius-panel] bg-brand-600 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-brand-800"
        >
          Upload files
        </Link>
        <input
          type="search"
          placeholder="Search name, company, city, state…"
          aria-label="Search files"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 rounded-[--radius-panel] border border-border bg-surface px-3 py-2 text-sm focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/25 sm:max-w-xs"
        />
        <select
          aria-label="Filter by type"
          value={category}
          onChange={(e) => setCategory(e.target.value as "all" | FileCategory)}
          className="rounded-[--radius-panel] border border-border bg-surface px-3 py-2 text-sm focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/25"
        >
          <option value="all">All types</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABEL[c]}
            </option>
          ))}
        </select>
      </div>

      {/* Bulk bar */}
      {selected.size > 0 && (
        <div className="mt-3 flex items-center justify-between rounded-[--radius-panel] border border-border bg-canvas px-4 py-2 text-sm">
          <span>{selected.size} selected</span>
          <button
            type="button"
            disabled={bulkBusy}
            onClick={() => setBulkDialog(true)}
            className="rounded-[--radius-panel] border border-red-200 px-3 py-1 text-xs font-medium text-danger-600 hover:bg-red-50 disabled:opacity-50"
          >
            Delete selected
          </button>
        </div>
      )}

      <ConfirmDialog
        open={bulkDialog}
        title={`Delete ${selected.size} file${selected.size === 1 ? "" : "s"}?`}
        body="The selected files are permanently removed, along with any published contact cards. This can't be undone."
        confirmLabel="Delete"
        danger
        busy={bulkBusy}
        onCancel={() => setBulkDialog(false)}
        onConfirm={() => void bulkDelete()}
      />

      {/* Table / states */}
      <div className="mt-4 rounded-[--radius-panel] border border-border bg-surface">
        {phase === "error" ? (
          <div className="p-10 text-center text-sm text-muted-500">
            <p>Couldn&apos;t load your files.</p>
            <button
              type="button"
              onClick={() => void reloadAll()}
              className="mt-3 rounded-[--radius-panel] border border-border px-3 py-1 text-xs font-medium hover:bg-canvas"
            >
              Retry
            </button>
          </div>
        ) : items.length === 0 ? (
          <p className="p-10 text-center text-sm text-muted-500">
            {query || category !== "all"
              ? "No files match your search."
              : "No files yet. Upload one to get started."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table
              className={`w-full min-w-[760px] text-left text-sm ${
                loading ? "opacity-60" : ""
              }`}
            >
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-500">
                  <th scope="col" className="w-10 px-4 py-2.5">
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={allSelected}
                      onChange={toggleAll}
                      disabled={manageable.length === 0}
                      className="h-4 w-4 rounded-sm border-border accent-brand-600"
                    />
                  </th>
                  <SortHeader
                    label="Name"
                    active={sort === "name"}
                    dir={dir}
                    onClick={() => sortBy("name")}
                  />
                  <SortHeader
                    label="Size"
                    active={sort === "size"}
                    dir={dir}
                    onClick={() => sortBy("size")}
                  />
                  <SortHeader
                    label="Modified"
                    active={sort === "modified"}
                    dir={dir}
                    onClick={() => sortBy("modified")}
                  />
                  <th scope="col" className="px-4 py-2.5 font-medium">Uploaded by</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Engagement</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.map((f) => (
                  <FileRow
                    key={f.id}
                    file={f}
                    selected={selected.has(f.id)}
                    onToggle={() => toggle(f.id)}
                    onChanged={reloadAll}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Load more */}
      {cursor && items.length > 0 && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            disabled={phase === "loadingMore"}
            onClick={() => void loadMore()}
            className="rounded-[--radius-panel] border border-border bg-surface px-4 py-2 text-sm font-medium text-slate-700 hover:bg-canvas disabled:opacity-60"
          >
            {phase === "loadingMore" ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}

function SortHeader({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: Dir;
  onClick: () => void;
}) {
  return (
    <th scope="col" className="px-4 py-2.5 font-medium">
      <button
        type="button"
        onClick={onClick}
        aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
        className={`inline-flex items-center gap-1 uppercase tracking-wide hover:text-slate-700 ${
          active ? "text-slate-700" : ""
        }`}
      >
        {label}
        <span aria-hidden className="text-[9px]">
          {active ? (dir === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </button>
    </th>
  );
}

function FileRow({
  file,
  selected,
  onToggle,
  onChanged,
}: {
  file: SerializedFile;
  selected: boolean;
  onToggle: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(file.name);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{
    top?: number;
    bottom?: number;
    right: number;
  } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [dialog, setDialog] = useState<null | "delete" | "unpublish">(null);
  const [copied, setCopied] = useState(false);

  // Position a portalled menu at the button, and close it on scroll/resize so it
  // never floats out of place. Opens upward for rows near the bottom of the
  // viewport so the (fixed-position) menu is never clipped off-screen.
  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      const right = window.innerWidth - r.right;
      const spaceBelow = window.innerHeight - r.bottom;
      const MENU_MAX = 280; // generous upper bound for the tallest menu
      if (spaceBelow < MENU_MAX && r.top > spaceBelow) {
        setMenuPos({ bottom: window.innerHeight - r.top + 4, right });
      } else {
        setMenuPos({ top: r.bottom + 4, right });
      }
    }
    setMenuOpen(true);
  };
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menuOpen]);

  const cat = fileCategory(file.name, file.contentType, file.kind);
  const published = file.visibility === "public";
  const canDownload = file.visibility === "private" && file.status === "ready";
  const subtitle = file.contactOrg || file.contactName || "";

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  const rename = () =>
    act(async () => {
      const name = nameDraft.trim();
      if (!name || name === file.name) {
        setRenaming(false);
        return;
      }
      const res = await fetch(`/api/files/${file.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "Couldn't rename.");
      }
      setRenaming(false);
      await onChanged();
    });

  const download = () =>
    act(async () => {
      const res = await fetch(`/api/files/${file.id}/link`, { method: "POST" });
      const b = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };
      if (!res.ok || !b.url) throw new Error(b.error ?? "Couldn't create a link.");
      window.open(b.url, "_blank", "noopener,noreferrer");
    });

  const unpublish = () =>
    act(async () => {
      const res = await fetch(`/api/files/${file.id}/unpublish`, {
        method: "POST",
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "Couldn't unpublish.");
      }
      await onChanged();
    });

  const remove = () =>
    act(async () => {
      const res = await fetch(`/api/files/${file.id}`, { method: "DELETE" });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "Couldn't delete.");
      }
      await onChanged();
    });

  const copyLink = () =>
    act(async () => {
      if (!file.publicUrl) return;
      await navigator.clipboard.writeText(file.publicUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });

  return (
    <tr className="align-top hover:bg-canvas/50">
      <td className="px-4 py-3">
        <input
          type="checkbox"
          aria-label={`Select ${file.name}`}
          checked={selected}
          onChange={onToggle}
          disabled={!file.canManage}
          className="h-4 w-4 rounded-sm border-border accent-brand-600 disabled:opacity-40"
        />
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2.5">
          <TypeBadge category={cat} />
          {renaming ? (
            <span className="flex items-center gap-1">
              <input
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void rename();
                  if (e.key === "Escape") {
                    setNameDraft(file.name);
                    setRenaming(false);
                  }
                }}
                className="rounded border border-border bg-canvas px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500/25"
              />
              <button type="button" disabled={busy} onClick={() => void rename()} className="rounded border border-border px-2 py-0.5 text-[11px] hover:bg-canvas">
                Save
              </button>
            </span>
          ) : (
            <span className="block min-w-0">
              {file.landingUrl ? (
                <a
                  href={file.landingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open the public card page"
                  className="block truncate font-medium text-brand-700 hover:text-brand-900 hover:underline"
                >
                  {file.name}
                </a>
              ) : (
                <span className="block truncate font-medium text-slate-800">
                  {file.name}
                </span>
              )}
              {subtitle && (
                <span className="block truncate text-xs text-muted-500">
                  {subtitle}
                </span>
              )}
            </span>
          )}
        </div>
        {error && <p className="mt-1 text-xs text-danger-600">{error}</p>}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-muted-500">
        {formatBytes(file.sizeBytes)}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-muted-500">
        {timeAgo(file.updatedAt)}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-muted-500">
        {file.uploadedByName}
      </td>
      <td className="px-4 py-3 whitespace-nowrap">
        <EngagementCell stats={file.stats} />
      </td>
      <td className="px-4 py-3">
        <StatusBadge file={file} />
      </td>
      <td className="px-4 py-3">
        <div className="flex justify-end">
          <button
            ref={btnRef}
            type="button"
            aria-label={`Actions for ${file.name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => (menuOpen ? setMenuOpen(false) : openMenu())}
            className="rounded-[--radius-panel] border border-border px-2 py-1 text-slate-600 hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
          >
            <DotsIcon className="h-4 w-4" />
          </button>
        </div>

        {menuOpen &&
          menuPos &&
          createPortal(
            <>
              <button
                type="button"
                aria-hidden
                tabIndex={-1}
                onClick={() => setMenuOpen(false)}
                className="fixed inset-0 z-40 cursor-default"
              />
              <div
                role="menu"
                style={{
                  top: menuPos.top,
                  bottom: menuPos.bottom,
                  right: menuPos.right,
                  maxHeight: "calc(100vh - 16px)",
                }}
                className="fixed z-50 w-44 overflow-y-auto rounded-[--radius-panel] border border-border bg-surface py-1 text-left shadow-lg"
              >
                {published && file.publicUrl && (
                  <MenuItem onClick={() => { setMenuOpen(false); void copyLink(); }}>
                    {copied ? "Copied" : "Copy link"}
                  </MenuItem>
                )}
                {published && file.kind === "vcard" && (
                  <MenuLink
                    href={`/signature/${file.id}`}
                    onSelect={() => setMenuOpen(false)}
                  >
                    Signature
                  </MenuLink>
                )}
                {published && file.kind === "vcard" && file.canManage && (
                  <MenuLink
                    href={`/files/${file.id}/edit`}
                    onSelect={() => setMenuOpen(false)}
                  >
                    Edit card
                  </MenuLink>
                )}
                {canDownload && (
                  <MenuItem onClick={() => { setMenuOpen(false); void download(); }}>
                    Download
                  </MenuItem>
                )}
                {file.canManage && (
                  <MenuItem
                    onClick={() => {
                      setMenuOpen(false);
                      setNameDraft(file.name);
                      setRenaming(true);
                    }}
                  >
                    Rename
                  </MenuItem>
                )}
                {published && file.canManage && (
                  <MenuItem onClick={() => { setMenuOpen(false); setDialog("unpublish"); }}>
                    Unpublish
                  </MenuItem>
                )}
                {file.canManage && (
                  <MenuItem danger onClick={() => { setMenuOpen(false); setDialog("delete"); }}>
                    Delete
                  </MenuItem>
                )}
              </div>
            </>,
            document.body,
          )}

        <ConfirmDialog
          open={dialog === "delete"}
          title={`Delete "${file.name}"?`}
          body={
            published
              ? "This permanently removes the file and takes its published contact card offline. This can't be undone."
              : "This permanently removes the file. This can't be undone."
          }
          confirmLabel="Delete"
          danger
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            await remove();
            setDialog(null);
          }}
        />
        <ConfirmDialog
          open={dialog === "unpublish"}
          title={`Unpublish "${file.name}"?`}
          body="The public address will stop resolving. The private copy is kept, so you can publish it again later."
          confirmLabel="Unpublish"
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            await unpublish();
            setDialog(null);
          }}
        />
      </td>
    </tr>
  );
}

function MenuItem({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`block w-full px-3 py-2 text-left text-sm hover:bg-canvas ${
        danger ? "text-danger-600" : "text-slate-700"
      }`}
    >
      {children}
    </button>
  );
}

// A navigating menu entry (the signature page is a full route, not an in-place
// action), styled to match MenuItem. Closes the menu on select.
function MenuLink({
  href,
  onSelect,
  children,
}: {
  href: string;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      role="menuitem"
      onClick={onSelect}
      className="block w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-canvas"
    >
      {children}
    </Link>
  );
}

// Compact per-card engagement (spec 0008): views, scans, downloads, each with an
// icon + count and a tooltip. A dash for private/non-vCard rows, which have no
// public landing page; all-zeros for a published card nobody has opened yet.
function EngagementCell({ stats }: { stats: SerializedFile["stats"] }) {
  if (!stats) return <span className="text-muted-400">—</span>;
  return (
    <span className="flex items-center gap-3 text-xs tabular-nums text-muted-500">
      <span className="inline-flex items-center gap-1" title="Views">
        <EyeIcon className="h-3.5 w-3.5" />
        {stats.views}
      </span>
      <span className="inline-flex items-center gap-1" title="QR scans">
        <ScanIcon className="h-3.5 w-3.5" />
        {stats.scans}
      </span>
      <span className="inline-flex items-center gap-1" title="Downloads">
        <DownloadIcon className="h-3.5 w-3.5" />
        {stats.downloads}
      </span>
    </span>
  );
}

function EyeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden className={className}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="2.75" />
    </svg>
  );
}

function ScanIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden className={className}>
      <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" strokeLinecap="round" />
      <path d="M4 12h16" strokeLinecap="round" />
    </svg>
  );
}

function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden className={className}>
      <path d="M12 4v10m0 0 3.5-3.5M12 14l-3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 18.5h14" strokeLinecap="round" />
    </svg>
  );
}

function DotsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}

function StatusBadge({ file }: { file: SerializedFile }) {
  let label = "Private";
  let cls = "bg-slate-100 text-slate-600";
  if (file.status === "failed") {
    label = "Failed";
    cls = "bg-red-50 text-danger-600";
  } else if (file.status !== "ready") {
    label = "Processing";
    cls = "bg-accent-500/10 text-accent-500";
  } else if (file.visibility === "public") {
    label = "Published";
    cls = "bg-emerald-100 text-emerald-700";
  }
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {label}
    </span>
  );
}

const BADGE: Record<FileCategory, { text: string; cls: string }> = {
  vcard: { text: "VCF", cls: "bg-accent-500/10 text-accent-500" },
  pdf: { text: "PDF", cls: "bg-red-50 text-danger-600" },
  image: { text: "IMG", cls: "bg-emerald-100 text-emerald-700" },
  document: { text: "DOC", cls: "bg-brand-600/10 text-brand-600" },
  archive: { text: "ZIP", cls: "bg-amber-100 text-amber-700" },
  other: { text: "FILE", cls: "bg-slate-100 text-slate-500" },
};

function TypeBadge({ category }: { category: FileCategory }) {
  const b = BADGE[category];
  return (
    <span
      className={`flex h-7 w-9 shrink-0 items-center justify-center rounded text-[10px] font-bold ${b.cls}`}
      aria-hidden
    >
      {b.text}
    </span>
  );
}
