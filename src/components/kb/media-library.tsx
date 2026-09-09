"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { formatBytes } from "@/lib/format";
import { uploadHelpImage } from "@/lib/help-image-upload";
import {
  deleteMediaImage,
  fetchMediaImages,
  type MediaImage,
  patchMediaImage,
} from "./media-shared";

// The Knowledge base media library (spec 0026 AC-1), styled to docs/Designs/mock-media-view.jpg:
// a sortable list (or grid) of the org's images with a right "Selected Asset Details" rail for
// preview, metadata, alt text / name editing, usage, and delete. Admin/owner (the /kb layout
// gates it). Adapted to our data model (images only; Name + Alt text, no Title/Caption schema).

type View = "list" | "grid";
type Sort = "newest" | "name" | "size";

function fmtDate(value: string | number | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function MediaLibrary() {
  const [images, setImages] = useState<MediaImage[] | null>(null);
  const [error, setError] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<View>("list");
  const [sort, setSort] = useState<Sort>("newest");
  const [query, setQuery] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function toggleChecked(id: string) {
    setBulkMsg(null);
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const load = useCallback(async () => {
    setError(false);
    try {
      setImages(await fetchMediaImages());
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    setUploading(true);
    let lastId: string | null = null;
    for (const file of files) {
      const up = await uploadHelpImage(file);
      if (up) lastId = up.imageId;
    }
    setUploading(false);
    await load();
    if (lastId) setSelectedId(lastId);
  }

  const visible = useMemo(() => {
    if (!images) return [];
    const q = query.trim().toLowerCase();
    const list = images.filter((i) =>
      q ? (i.filename ?? "").toLowerCase().includes(q) : true,
    );
    return [...list].sort((a, b) => {
      if (sort === "name")
        return (a.filename ?? "").localeCompare(b.filename ?? "");
      if (sort === "size") return (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);
      // newest: createdAt desc (fall back to nothing when equal)
      return new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime();
    });
  }, [images, query, sort]);

  const selected = images?.find((i) => i.id === selectedId) ?? null;

  const visibleIds = visible.map((i) => i.id);
  const allVisibleChecked =
    visibleIds.length > 0 && visibleIds.every((id) => checked.has(id));

  function toggleAll() {
    setBulkMsg(null);
    setChecked((prev) => {
      if (visibleIds.every((id) => prev.has(id))) return new Set();
      return new Set(visibleIds);
    });
  }

  async function deleteSelected() {
    const targets = (images ?? []).filter((i) => checked.has(i.id));
    const deletable = targets.filter((i) => !i.inUse);
    const blocked = targets.length - deletable.length;
    setBulkDeleting(true);
    setBulkMsg(null);
    for (const img of deletable) await deleteMediaImage(img.id);
    setBulkDeleting(false);
    setConfirmBulk(false);
    if (selectedId && deletable.some((d) => d.id === selectedId)) setSelectedId(null);
    setChecked(new Set());
    await load();
    if (blocked > 0) {
      setBulkMsg(
        `Deleted ${deletable.length}. ${blocked} still used by an article and kept.`,
      );
    }
  }

  // Counts for the bulk-delete confirmation copy.
  const checkedImages = (images ?? []).filter((i) => checked.has(i.id));
  const bulkDeletable = checkedImages.filter((i) => !i.inUse).length;
  const bulkBlocked = checkedImages.length - bulkDeletable;

  return (
    <div className="flex flex-col gap-6 xl:flex-row">
      <div className="min-w-0 flex-1">
        <h1 className="text-2xl font-bold text-brand-900">Media library</h1>
        <p className="mt-1 text-sm text-muted-500">
          Images used in help articles. Large uploads are shrunk automatically.
        </p>

        {/* Toolbar: search, sort, view toggle */}
        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search media files…"
            className="flex-1 rounded-[--radius-panel] border border-border bg-surface px-3 py-2 text-sm text-slate-800 placeholder:text-muted-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
          />
          <label className="relative shrink-0">
            <span className="sr-only">Sort</span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as Sort)}
              className="rounded-[--radius-panel] border border-border bg-surface py-2 pl-3 pr-8 text-sm font-medium text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
            >
              <option value="newest">Newest</option>
              <option value="name">Name</option>
              <option value="size">Size</option>
            </select>
          </label>
          <div className="inline-flex shrink-0 overflow-hidden rounded-[--radius-panel] border border-border">
            <ViewButton active={view === "grid"} onClick={() => setView("grid")} label="Grid">
              <GridIcon className="h-4 w-4" />
            </ViewButton>
            <ViewButton active={view === "list"} onClick={() => setView("list")} label="List">
              <ListIcon className="h-4 w-4" />
            </ViewButton>
          </div>
        </div>

        {/* Bulk action bar */}
        {checked.size > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-[--radius-panel] border border-border bg-canvas px-3 py-2 text-sm">
            <span className="font-medium text-slate-800">{checked.size} selected</span>
            <button
              type="button"
              onClick={() => {
                if (bulkDeletable === 0) {
                  setBulkMsg(
                    "Every selected image is still used by an article, so nothing can be deleted.",
                  );
                  return;
                }
                setConfirmBulk(true);
              }}
              disabled={bulkDeleting}
              className="rounded-[--radius-panel] border border-red-200 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              {bulkDeleting ? "Deleting…" : "Delete selected"}
            </button>
            <button
              type="button"
              onClick={() => setChecked(new Set())}
              className="text-xs font-medium text-muted-500 hover:text-slate-700"
            >
              Clear
            </button>
            <span className="text-xs text-muted-500">In-use images are kept.</span>
          </div>
        )}
        {bulkMsg && <p className="mt-2 text-xs text-slate-700">{bulkMsg}</p>}

        {/* Content */}
        <div className="mt-4">
          {error ? (
            <div className="rounded-[--radius-panel] border border-border bg-surface p-8 text-center text-sm text-muted-500">
              <p>Couldn&apos;t load your media.</p>
              <button
                type="button"
                onClick={() => void load()}
                className="mt-3 rounded-[--radius-panel] border border-border px-3 py-1 text-xs font-medium hover:bg-canvas"
              >
                Retry
              </button>
            </div>
          ) : images === null ? (
            <p className="p-8 text-center text-sm text-muted-500">Loading…</p>
          ) : images.length === 0 ? (
            <div className="rounded-[--radius-panel] border border-border bg-surface p-10 text-center text-sm text-muted-500">
              No images yet. Add one from the panel on the right.
            </div>
          ) : view === "list" ? (
            <ListView
              items={visible}
              selectedId={selectedId}
              onSelect={setSelectedId}
              checked={checked}
              onToggle={toggleChecked}
              onToggleAll={toggleAll}
              allChecked={allVisibleChecked}
            />
          ) : (
            <GridView
              items={visible}
              selectedId={selectedId}
              onSelect={setSelectedId}
              checked={checked}
              onToggle={toggleChecked}
            />
          )}
          {images && images.length > 0 && (
            <p className="mt-3 text-xs text-muted-500">
              Showing {visible.length} of {images.length}{" "}
              {images.length === 1 ? "image" : "images"}
            </p>
          )}
        </div>
      </div>

      {/* Right rail */}
      <aside className="w-full shrink-0 xl:w-80">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="w-full rounded-[--radius-panel] bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-50"
        >
          {uploading ? "Uploading…" : "Add media"}
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/gif,image/webp"
          className="hidden"
          onChange={onUpload}
        />

        <div className="mt-4 rounded-[--radius-panel] border border-border bg-surface p-4">
          {selected ? (
            <AssetDetails
              key={selected.id}
              img={selected}
              onChanged={load}
              onDeleted={() => {
                setSelectedId(null);
                void load();
              }}
            />
          ) : (
            <p className="py-6 text-center text-sm text-muted-500">
              Select an asset to see its details.
            </p>
          )}
        </div>
      </aside>

      <ConfirmDialog
        open={confirmBulk}
        title={`Delete ${bulkDeletable} ${bulkDeletable === 1 ? "image" : "images"}?`}
        body={
          <>
            This permanently removes {bulkDeletable === 1 ? "the image" : "the images"} and{" "}
            {bulkDeletable === 1 ? "its" : "their"} files. This can&apos;t be undone.
            {bulkBlocked > 0 && (
              <span className="mt-2 block">
                {bulkBlocked} selected {bulkBlocked === 1 ? "image is" : "images are"} still used
                by an article and will be kept.
              </span>
            )}
          </>
        }
        confirmLabel={`Delete ${bulkDeletable}`}
        danger
        busy={bulkDeleting}
        onCancel={() => setConfirmBulk(false)}
        onConfirm={() => void deleteSelected()}
      />
    </div>
  );
}

function ListView({
  items,
  selectedId,
  onSelect,
  checked,
  onToggle,
  onToggleAll,
  allChecked,
}: {
  items: MediaImage[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  checked: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  allChecked: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-[--radius-panel] border border-border bg-surface">
      <table className="w-full min-w-[680px] text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-500">
            <th className="w-10 px-4 py-2.5">
              <input
                type="checkbox"
                aria-label="Select all"
                checked={allChecked}
                onChange={onToggleAll}
                className="align-middle"
              />
            </th>
            <th className="px-4 py-2.5 font-medium">Filename</th>
            <th className="px-4 py-2.5 font-medium">Type</th>
            <th className="px-4 py-2.5 font-medium">Size</th>
            <th className="px-4 py-2.5 font-medium">Dimensions</th>
            <th className="px-4 py-2.5 font-medium">Added</th>
            <th className="px-4 py-2.5 font-medium">Usage</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {items.map((img) => {
            const active = img.id === selectedId;
            return (
              <tr
                key={img.id}
                onClick={() => onSelect(img.id)}
                className={`cursor-pointer ${active ? "bg-accent-500/5" : "hover:bg-canvas/60"}`}
              >
                <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${img.filename ?? "image"}`}
                    checked={checked.has(img.id)}
                    onChange={() => onToggle(img.id)}
                    className="align-middle"
                  />
                </td>
                <td className="px-4 py-2.5">
                  <span className="flex items-center gap-3">
                    <span className="h-10 w-10 shrink-0 overflow-hidden rounded border border-border bg-canvas">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={img.url} alt="" className="h-full w-full object-cover" />
                    </span>
                    <span className="truncate font-medium text-slate-800">
                      {img.filename || "Untitled"}
                    </span>
                  </span>
                </td>
                <td className="px-4 py-2.5 text-muted-500">
                  {img.contentType.replace("image/", "").toUpperCase()}
                </td>
                <td className="px-4 py-2.5 text-muted-500">
                  {img.sizeBytes ? formatBytes(img.sizeBytes) : "—"}
                </td>
                <td className="px-4 py-2.5 text-muted-500">
                  {img.width && img.height ? `${img.width}×${img.height}` : "—"}
                </td>
                <td className="px-4 py-2.5 text-muted-500">{fmtDate(img.createdAt)}</td>
                <td className="px-4 py-2.5">
                  <UsageBadge inUse={img.inUse} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function GridView({
  items,
  selectedId,
  onSelect,
  checked,
  onToggle,
}: {
  items: MediaImage[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  checked: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {items.map((img) => {
        const active = img.id === selectedId;
        return (
          <li key={img.id} className="relative">
            <button
              type="button"
              onClick={() => onSelect(img.id)}
              className={`block w-full overflow-hidden rounded-[--radius-panel] border bg-surface text-left ${
                active ? "border-accent-500 ring-2 ring-accent-500/30" : "border-border hover:border-accent-500/50"
              }`}
            >
              <span className="relative flex aspect-square items-center justify-center overflow-hidden bg-canvas">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.url} alt="" className="h-full w-full object-cover" />
                <span className="absolute right-1.5 top-1.5">
                  <UsageBadge inUse={img.inUse} compact />
                </span>
              </span>
              <span className="block truncate px-2 py-1.5 text-xs text-slate-700">
                {img.filename || "Untitled"}
              </span>
            </button>
            <input
              type="checkbox"
              aria-label={`Select ${img.filename ?? "image"}`}
              checked={checked.has(img.id)}
              onChange={() => onToggle(img.id)}
              className="absolute left-2 top-2 z-10"
            />
          </li>
        );
      })}
    </ul>
  );
}

function AssetDetails({
  img,
  onChanged,
  onDeleted,
}: {
  img: MediaImage;
  onChanged: () => Promise<void>;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(img.filename ?? "");
  const [title, setTitle] = useState(img.title ?? "");
  const [caption, setCaption] = useState(img.caption ?? "");
  const [alt, setAlt] = useState(img.altText ?? "");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const dirty =
    name !== (img.filename ?? "") ||
    title !== (img.title ?? "") ||
    caption !== (img.caption ?? "") ||
    alt !== (img.altText ?? "");

  async function save() {
    setSaving(true);
    setMsg(null);
    const ok = await patchMediaImage(img.id, {
      filename: name.trim(),
      title: title.trim() || null,
      caption: caption.trim() || null,
      alt: alt.trim() || null,
    });
    setSaving(false);
    if (ok) await onChanged();
    else setMsg("Couldn't save. Try again.");
  }

  function askDelete() {
    if (img.inUse) {
      setMsg("This image is still used by an article. Remove it there first.");
      return;
    }
    setMsg(null);
    setConfirming(true);
  }

  async function del() {
    setDeleting(true);
    setMsg(null);
    const res = await deleteMediaImage(img.id);
    setDeleting(false);
    if (res.ok) {
      onDeleted();
    } else {
      setConfirming(false);
      setMsg(res.error);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}${img.url}`,
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setMsg("Couldn't copy the link.");
    }
  }

  return (
    <div>
      <h2 className="text-sm font-semibold text-slate-800">Selected asset details</h2>

      <div className="mt-3 overflow-hidden rounded-[--radius-panel] border border-border bg-canvas">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={img.url} alt={img.altText ?? ""} className="max-h-48 w-full object-contain" />
      </div>

      <dl className="mt-3 space-y-1 text-xs text-muted-500">
        <Row label="Type" value={img.contentType.replace("image/", "").toUpperCase()} />
        <Row label="Size" value={img.sizeBytes ? formatBytes(img.sizeBytes) : "—"} />
        <Row
          label="Dimensions"
          value={img.width && img.height ? `${img.width}×${img.height}` : "—"}
        />
        <Row label="Added" value={fmtDate(img.createdAt)} />
      </dl>

      <label className="mt-3 block">
        <span className="text-xs font-medium text-slate-700">Name (file)</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={200}
          className="mt-1 w-full rounded-[--radius-panel] border border-border bg-canvas px-2.5 py-1.5 text-sm"
        />
      </label>
      <label className="mt-2 block">
        <span className="text-xs font-medium text-slate-700">Title</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          placeholder="A human title"
          className="mt-1 w-full rounded-[--radius-panel] border border-border bg-canvas px-2.5 py-1.5 text-sm"
        />
      </label>
      <label className="mt-2 block">
        <span className="text-xs font-medium text-slate-700">Alt text</span>
        <input
          value={alt}
          onChange={(e) => setAlt(e.target.value)}
          maxLength={500}
          placeholder="Describe the image"
          className="mt-1 w-full rounded-[--radius-panel] border border-border bg-canvas px-2.5 py-1.5 text-sm"
        />
      </label>
      <label className="mt-2 block">
        <span className="text-xs font-medium text-slate-700">Caption</span>
        <textarea
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          maxLength={1000}
          rows={2}
          placeholder="Optional caption"
          className="mt-1 w-full resize-y rounded-[--radius-panel] border border-border bg-canvas px-2.5 py-1.5 text-sm"
        />
      </label>

      <div className="mt-3">
        <span className="text-xs font-medium text-slate-700">Usage</span>
        {img.usedBy.length === 0 ? (
          <p className="mt-1 text-xs text-muted-500">Not used in any article.</p>
        ) : (
          <>
            <p className="mt-1 text-xs text-muted-500">
              Used in {img.usedBy.length} {img.usedBy.length === 1 ? "article" : "articles"}:
            </p>
            <ul className="mt-1 list-disc pl-4 text-xs text-slate-700">
              {img.usedBy.map((a) => (
                <li key={a.id}>{a.title}</li>
              ))}
            </ul>
          </>
        )}
      </div>

      {msg && <p className="mt-2 text-xs text-red-600">{msg}</p>}

      <div className="mt-4 space-y-2">
        <button
          type="button"
          onClick={save}
          disabled={saving || !dirty}
          className="w-full rounded-[--radius-panel] bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Update metadata"}
        </button>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={copyLink}
            className="flex-1 rounded-[--radius-panel] border border-border px-3 py-2 text-sm font-medium text-slate-700 hover:bg-canvas"
          >
            {copied ? "Copied" : "Copy link"}
          </button>
          <button
            type="button"
            onClick={askDelete}
            disabled={deleting}
            className="flex-1 rounded-[--radius-panel] border border-red-200 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        title={`Delete “${img.filename || "this image"}”?`}
        body="This permanently removes the image and its file. This can't be undone."
        confirmLabel="Delete"
        danger
        busy={deleting}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void del()}
      />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt>{label}</dt>
      <dd className="text-slate-700">{value}</dd>
    </div>
  );
}

function UsageBadge({ inUse, compact }: { inUse: boolean; compact?: boolean }) {
  return (
    <span
      className={`inline-block rounded-full font-medium ${
        compact ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-[11px]"
      } ${inUse ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}`}
    >
      {inUse ? "Used" : "Unused"}
    </span>
  );
}

function ViewButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={`flex items-center justify-center px-2.5 py-2 ${
        active ? "bg-brand-600 text-white" : "bg-surface text-muted-500 hover:bg-canvas"
      }`}
    >
      {children}
    </button>
  );
}

function GridIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function ListIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  );
}
