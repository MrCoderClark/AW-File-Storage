"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { uploadHelpImage } from "@/lib/help-image-upload";
import { fetchMediaImages, type MediaImage } from "./media-shared";

// A modal that lets an author reuse an existing library image or upload a new one (spec 0026
// AC-3). Used by the article editor for both "insert image" and "set featured image". Picking an
// image calls onSelect with the full MediaImage (so the caller can use its url + alt text).

export function MediaPicker({
  title = "Choose an image",
  onSelect,
  onClose,
}: {
  title?: string;
  onSelect: (image: MediaImage) => void;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [images, setImages] = useState<MediaImage[] | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    let alive = true;
    fetchMediaImages()
      .then((imgs) => alive && setImages(imgs))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    const up = await uploadHelpImage(file);
    setBusy(false);
    if (!up) {
      setError(true);
      return;
    }
    // Re-fetch so the new image (with metadata) appears, then select it.
    const imgs = await fetchMediaImages().catch(() => null);
    if (imgs) setImages(imgs);
    const picked = imgs?.find((i) => i.id === up.imageId);
    if (picked) onSelect(picked);
  }

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={() => !busy && onClose()}
        className="absolute inset-0 cursor-default bg-slate-900/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex max-h-[80vh] w-full max-w-2xl flex-col rounded-[--radius-panel] border border-border bg-surface shadow-xl"
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold text-brand-900">{title}</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="rounded-[--radius-panel] bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-50"
            >
              {busy ? "Uploading…" : "Upload new"}
            </button>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="rounded p-1 text-muted-500 hover:bg-canvas"
            >
              ✕
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="hidden"
            onChange={onUpload}
          />
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error ? (
            <p className="p-6 text-center text-sm text-muted-500">
              Couldn&apos;t load your media.
            </p>
          ) : images === null ? (
            <p className="p-6 text-center text-sm text-muted-500">Loading…</p>
          ) : images.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-500">
              No images yet. Upload one to get started.
            </p>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {images.map((img) => (
                <li key={img.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(img)}
                    className="group block w-full overflow-hidden rounded-[--radius-panel] border border-border bg-canvas text-left hover:border-accent-500"
                  >
                    <span className="flex aspect-video items-center justify-center overflow-hidden bg-canvas">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={img.url}
                        alt={img.altText ?? ""}
                        className="h-full w-full object-cover"
                      />
                    </span>
                    <span className="block truncate px-2 py-1.5 text-xs text-slate-700">
                      {img.filename || "Untitled"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
