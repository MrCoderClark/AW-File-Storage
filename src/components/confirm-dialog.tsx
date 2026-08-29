"use client";

import { useEffect } from "react";

// A small modal confirmation dialog (spec 0007): backdrop, centred panel,
// Escape/backdrop to cancel, a danger variant for destructive actions.
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button
        type="button"
        aria-label="Cancel"
        onClick={onCancel}
        className="absolute inset-0 bg-black/40"
      />
      <div className="relative w-full max-w-md rounded-[--radius-drop] border border-border bg-surface p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-brand-900">{title}</h2>
        <div className="mt-2 text-sm text-muted-500">{body}</div>
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-[--radius-panel] border border-border px-4 py-2 text-sm font-medium text-slate-700 hover:bg-canvas disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`rounded-[--radius-panel] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 ${
              danger ? "bg-danger-600 hover:bg-red-700" : "bg-brand-600 hover:bg-brand-800"
            }`}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
