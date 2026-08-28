"use client";

// Organization file list (spec 0004; PROGRESS Phase 4c). Loads the org's live
// files from GET /api/files and offers per-row actions — copy public link,
// download (signed link), unpublish, delete — gated by what the caller may do.
// Re-fetches whenever the shared refresh signal bumps (a completed upload), and
// bumps it after its own mutating actions so the rail stays in sync.

import { useCallback, useEffect, useState } from "react";
import { useAppData } from "@/components/app-data";
import { formatBytes, timeAgo } from "@/lib/format";

interface FileItem {
  id: string;
  name: string;
  kind: "vcard" | "other";
  status: string;
  visibility: "private" | "public";
  sizeBytes: number;
  publicUrl?: string;
  createdAt: string;
  canManage: boolean;
}

type Display = {
  label: string;
  className: string;
};

function displayFor(f: FileItem): Display {
  if (f.status === "failed")
    return { label: "Failed", className: "bg-red-50 text-danger-600" };
  if (f.status === "pending")
    return { label: "Processing", className: "bg-accent-500/10 text-accent-500" };
  if (f.visibility === "public")
    return { label: "Published", className: "bg-emerald-100 text-emerald-700" };
  return { label: "Private", className: "bg-slate-100 text-slate-600" };
}

export function FileManager() {
  const { version, refresh } = useAppData();
  const [files, setFiles] = useState<FileItem[] | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    try {
      const res = await fetch("/api/files", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { files: FileItem[] };
      setFiles(body.files);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, version]);

  return (
    <section className="mx-auto mt-10 max-w-3xl">
      <h2 className="text-sm font-semibold text-slate-800">Your files</h2>

      <div className="mt-3 rounded-[--radius-panel] border border-border bg-surface">
        {error ? (
          <div className="p-8 text-center text-sm text-muted-500">
            <p>Couldn&apos;t load your files.</p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-3 rounded-[--radius-panel] border border-border px-3 py-1 text-xs font-medium hover:bg-canvas"
            >
              Retry
            </button>
          </div>
        ) : files === null ? (
          <ul className="divide-y divide-border">
            {[0, 1, 2].map((i) => (
              <li key={i} className="px-4 py-3">
                <div className="h-4 w-2/3 animate-pulse rounded bg-canvas" />
              </li>
            ))}
          </ul>
        ) : files.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-500">
            No files yet. Upload one above to get started.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {files.map((f) => (
              <FileRow key={f.id} file={f} onChange={refresh} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function FileRow({ file, onChange }: { file: FileItem; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const display = displayFor(file);

  const act = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      setActionError(null);
      try {
        await fn();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "Action failed.");
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const copyLink = () =>
    act(async () => {
      if (!file.publicUrl) return;
      await navigator.clipboard.writeText(file.publicUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });

  const download = () =>
    act(async () => {
      const res = await fetch(`/api/files/${file.id}/link`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };
      if (!res.ok || !body.url) throw new Error(body.error ?? "Couldn't create a link.");
      window.open(body.url, "_blank", "noopener,noreferrer");
    });

  const unpublish = () =>
    act(async () => {
      const res = await fetch(`/api/files/${file.id}/unpublish`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Couldn't unpublish.");
      }
      onChange();
    });

  const remove = () =>
    act(async () => {
      const res = await fetch(`/api/files/${file.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Couldn't delete.");
      }
      onChange();
    });

  const isPublished = file.visibility === "public";
  const canDownload = file.visibility === "private" && file.status === "ready";

  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-slate-800">
            {file.name}
          </span>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${display.className}`}
          >
            {display.label}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-muted-500">
          {formatBytes(file.sizeBytes)} · {timeAgo(file.createdAt)}
        </p>
        {isPublished && file.publicUrl && (
          <code className="mt-1 block truncate text-xs text-accent-500">
            {file.publicUrl}
          </code>
        )}
        {actionError && (
          <p className="mt-1 text-xs text-danger-600">{actionError}</p>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {isPublished && file.publicUrl && (
          <RowButton onClick={copyLink} disabled={busy}>
            {copied ? "Copied" : "Copy link"}
          </RowButton>
        )}
        {canDownload && (
          <RowButton onClick={download} disabled={busy}>
            Download
          </RowButton>
        )}
        {isPublished && file.canManage && (
          <RowButton onClick={unpublish} disabled={busy}>
            Unpublish
          </RowButton>
        )}
        {file.canManage &&
          (confirmDelete ? (
            <>
              <RowButton onClick={remove} disabled={busy} danger>
                Confirm
              </RowButton>
              <RowButton onClick={() => setConfirmDelete(false)} disabled={busy}>
                Cancel
              </RowButton>
            </>
          ) : (
            <RowButton
              onClick={() => setConfirmDelete(true)}
              disabled={busy}
              danger
            >
              Delete
            </RowButton>
          ))}
      </div>
    </li>
  );
}

function RowButton({
  children,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-[--radius-panel] border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 ${
        danger
          ? "border-red-200 text-danger-600 hover:bg-red-50"
          : "border-border text-slate-700 hover:bg-canvas"
      }`}
    >
      {children}
    </button>
  );
}
