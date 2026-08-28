"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppData } from "@/components/app-data";
import { FileManager } from "@/components/file-manager";
import { formatBytes } from "@/lib/format";

type Status =
  | "queued"
  | "requesting"
  | "uploading"
  | "finalizing"
  | "published"
  | "private"
  | "failed"
  | "rejected";

interface Item {
  id: string;
  file: File;
  status: Status;
  bytesSent: number;
  total: number;
  startedAt?: number;
  error?: string;
  publicUrl?: string;
}

const ACTIVE: Status[] = ["requesting", "uploading", "finalizing"];
const MAX_CONCURRENT = 3;

const BADGE: Record<Status, { label: string; className: string }> = {
  queued: { label: "Queued", className: "bg-slate-100 text-slate-600" },
  requesting: { label: "Starting", className: "bg-slate-100 text-slate-600" },
  uploading: { label: "Uploading", className: "bg-accent-500/10 text-accent-500" },
  finalizing: { label: "Processing", className: "bg-accent-500/10 text-accent-500" },
  published: { label: "Published", className: "bg-emerald-100 text-emerald-700" },
  private: { label: "Private", className: "bg-slate-100 text-slate-600" },
  failed: { label: "Failed", className: "bg-red-50 text-danger-600" },
  rejected: { label: "Rejected", className: "bg-red-50 text-danger-600" },
};

function putWithProgress(
  url: string,
  file: File,
  onProgress: (sent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed (${xhr.status})`));
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(file);
  });
}

export function UploadCenter() {
  const { refresh } = useAppData();
  const [items, setItems] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // Ids that have already announced their half-way point, so the live region
  // reports each milestone once rather than on every progress event (AC-14).
  const halfAnnounced = useRef<Set<string>>(new Set());

  const update = useCallback((id: string, patch: Partial<Item>) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  }, []);

  const addFiles = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;
    const next: Item[] = Array.from(files).map((file) => ({
      id: `${file.name}-${file.size}-${crypto.randomUUID()}`,
      file,
      status: "queued",
      bytesSent: 0,
      total: file.size,
    }));
    setItems((prev) => [...next, ...prev]);
  }, []);

  const runUpload = useCallback(
    async (item: Item) => {
      try {
        const res = await fetch("/api/uploads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: item.file.name,
            size: item.file.size,
            contentType: item.file.type || "application/octet-stream",
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          update(item.id, {
            status: "rejected",
            error: body.error ?? "Upload was rejected.",
          });
          return;
        }
        const { uploadSessionId, url } = (await res.json()) as {
          uploadSessionId: string;
          url: string;
        };

        update(item.id, { status: "uploading", startedAt: Date.now() });
        setAnnouncement(`Uploading ${item.file.name}`);
        await putWithProgress(url, item.file, (sent) => {
          update(item.id, { bytesSent: sent });
          if (
            item.total > 0 &&
            sent / item.total >= 0.5 &&
            !halfAnnounced.current.has(item.id)
          ) {
            halfAnnounced.current.add(item.id);
            setAnnouncement(`${item.file.name} halfway uploaded`);
          }
        });

        update(item.id, { status: "finalizing", bytesSent: item.total });
        const fin = await fetch("/api/uploads/finalize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uploadSessionId }),
        });
        if (!fin.ok) {
          const body = (await fin.json().catch(() => ({}))) as { error?: string };
          update(item.id, {
            status: "failed",
            error: body.error ?? "Processing failed.",
          });
          setAnnouncement(`${item.file.name} failed`);
          refresh();
          return;
        }
        const result = (await fin.json()) as {
          visibility: "public" | "private";
          publicUrl?: string;
        };
        const published = result.visibility === "public";
        update(item.id, {
          status: published ? "published" : "private",
          publicUrl: result.publicUrl,
        });
        setAnnouncement(
          published
            ? `${item.file.name} published`
            : `${item.file.name} uploaded and kept private`,
        );
        // The org now has a new file: refresh Storage Usage, Upload History,
        // Recent Activity, and the file list without a page reload (AC-10).
        refresh();
      } catch (e) {
        update(item.id, {
          status: "failed",
          error: e instanceof Error ? e.message : "Upload failed.",
        });
        setAnnouncement(`${item.file.name} failed`);
        refresh();
      }
    },
    [update, refresh],
  );

  // Scheduler: keep at most MAX_CONCURRENT uploads in flight.
  useEffect(() => {
    const running = items.filter((i) => ACTIVE.includes(i.status)).length;
    const slots = MAX_CONCURRENT - running;
    if (slots <= 0) return;
    const queued = items.filter((i) => i.status === "queued").slice(0, slots);
    for (const item of queued) {
      update(item.id, { status: "requesting" });
      void runUpload(item);
    }
  }, [items, runUpload, update]);

  function retry(id: string) {
    halfAnnounced.current.delete(id);
    update(id, { status: "queued", error: undefined, bytesSent: 0 });
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  };

  return (
    <div className="mx-auto max-w-3xl">
      {/* Polite announcements at meaningful moments only (AC-14). */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>

      <div className="flex flex-col items-center text-center">
        <CloudUpload className="h-14 w-14 text-accent-500" />
        <h1 className="mt-3 text-2xl font-semibold text-brand-900">
          Secure file upload
        </h1>
        <p className="mt-1 text-sm text-muted-500">
          Contact cards (.vcf) are published to a public address; everything else
          stays private.
        </p>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`mt-6 rounded-[--radius-drop] border-2 border-dashed px-6 py-12 text-center transition-colors ${
          dragging ? "border-accent-500 bg-accent-500/5" : "border-border bg-surface"
        }`}
      >
        <p className="text-sm text-muted-500">
          Drag &amp; drop files here to upload
        </p>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="mt-4 rounded-[--radius-panel] bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
        >
          Browse files
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="sr-only"
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {/* Upload table */}
      <div className="mt-6 rounded-[--radius-panel] border border-border bg-surface">
        {items.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-500">
            Nothing uploading. Drop a file to start.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((item) => (
              <UploadRow key={item.id} item={item} onRetry={() => retry(item.id)} />
            ))}
          </ul>
        )}
      </div>

      <FileManager />
    </div>
  );
}

function UploadRow({ item, onRetry }: { item: Item; onRetry: () => void }) {
  const pct = item.total > 0 ? Math.round((item.bytesSent / item.total) * 100) : 0;
  const badge = BADGE[item.status];
  const showBar = item.status === "uploading" || item.status === "finalizing";

  return (
    <li className="flex items-center gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-slate-800">
            {item.file.name}
          </span>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${badge.className}`}
          >
            {badge.label}
          </span>
        </div>

        {showBar && (
          <div className="mt-1.5 flex items-center gap-2">
            <div
              className="h-1.5 flex-1 overflow-hidden rounded-full bg-canvas"
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`Uploading ${item.file.name}`}
            >
              <div
                className="h-full rounded-full bg-accent-500 transition-[width]"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="w-24 shrink-0 text-right text-xs text-muted-500">
              {formatBytes(item.bytesSent)} / {formatBytes(item.total)}
            </span>
          </div>
        )}

        {item.status === "published" && item.publicUrl && (
          <CopyLink url={item.publicUrl} />
        )}
        {(item.status === "failed" || item.status === "rejected") && (
          <p className="mt-1 text-xs text-danger-600">{item.error}</p>
        )}
      </div>

      {(item.status === "failed" || item.status === "rejected") && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded-[--radius-panel] border border-border px-3 py-1 text-xs font-medium hover:bg-canvas"
        >
          Retry
        </button>
      )}
    </li>
  );
}

function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-1 flex items-center gap-2">
      <code className="truncate text-xs text-accent-500">{url}</code>
      <button
        type="button"
        onClick={async () => {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="shrink-0 rounded border border-border px-2 py-0.5 text-[11px] font-medium hover:bg-canvas"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function CloudUpload({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <path d="M6.5 19a4.5 4.5 0 0 1-.36-8.99A6 6 0 0 1 17.7 8.6 4.7 4.7 0 0 1 17.5 19" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 12v6M9.5 14.5 12 12l2.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
