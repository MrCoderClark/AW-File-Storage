"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

// "Generate with AI" modal (spec 0027). The admin enters a topic (and optional instructions);
// this calls POST /api/help/ai/draft and hands the returned draft back to the editor via onApply.
// It never saves or publishes — the editor fills its fields and the human reviews.

export interface AiDraft {
  title: string;
  excerpt: string;
  bodyHtml: string;
}

export function AiDraftPanel({
  onApply,
  onClose,
}: {
  onApply: (draft: AiDraft) => void;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [topic, setTopic] = useState("");
  const [instructions, setInstructions] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !loading) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, loading]);

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    if (!topic.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/help/ai/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: topic.trim(), instructions: instructions.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        title?: string;
        excerpt?: string;
        bodyHtml?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? "Couldn't generate a draft.");
      onApply({
        title: body.title ?? "",
        excerpt: body.excerpt ?? "",
        bodyHtml: body.bodyHtml ?? "",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't generate a draft.");
      setLoading(false);
    }
  }

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={() => !loading && onClose()}
        className="absolute inset-0 cursor-default bg-slate-900/40"
      />
      <form
        onSubmit={generate}
        role="dialog"
        aria-modal="true"
        aria-label="Generate with AI"
        className="relative w-full max-w-md rounded-[--radius-panel] border border-border bg-surface shadow-xl"
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold text-brand-900">Generate with AI</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded p-1 text-muted-500 hover:bg-canvas"
          >
            ✕
          </button>
        </header>

        <div className="p-4">
          <label className="block">
            <span className="text-xs font-medium text-slate-700">Topic</span>
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              maxLength={300}
              autoFocus
              placeholder="e.g. How to publish a contact card"
              className="mt-1 w-full rounded-[--radius-panel] border border-border bg-canvas px-3 py-2 text-sm text-slate-800 placeholder:text-muted-500 focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/25"
            />
          </label>
          <label className="mt-3 block">
            <span className="text-xs font-medium text-slate-700">
              Instructions <span className="text-muted-500">(optional)</span>
            </span>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              maxLength={1000}
              rows={3}
              placeholder="Tone, audience, length, anything specific to include…"
              className="mt-1 w-full resize-y rounded-[--radius-panel] border border-border bg-canvas px-3 py-2 text-sm text-slate-800 placeholder:text-muted-500 focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/25"
            />
          </label>

          <p className="mt-3 text-xs text-muted-500">
            The AI writes a first draft using your app&apos;s existing help. It can be wrong —
            review and edit before publishing.
          </p>

          {error && (
            <p className="mt-2 text-sm text-red-600" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="rounded-[--radius-panel] border border-border px-3 py-2 text-sm font-medium text-slate-700 hover:bg-canvas disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading || !topic.trim()}
            className="rounded-[--radius-panel] bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-50"
          >
            {loading ? "Generating…" : "Generate draft"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
