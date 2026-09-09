"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

// "Contact support" as a modal form (spec 0025 follow-up), replacing the old mailto link.
// Renders a trigger button (styled by the caller via `className` + children) that opens a
// slide-in dialog with a subject + message form. Submitting POSTs to /api/help/support, which
// emails the support inbox via Resend with the signed-in user as Reply-To. Reused by the help
// drawer and the /help "Need help?" box.

type Status = "idle" | "sending" | "sent" | "error";

const MAX_MESSAGE = 5000;

export function ContactSupport({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        {children}
      </button>
      {open && <ContactSupportDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function ContactSupportDialog({ onClose }: { onClose: () => void }) {
  const [mounted, setMounted] = useState(false);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();

  useEffect(() => setMounted(true), []);

  // Focus the message field once open; Esc closes (except mid-send).
  useEffect(() => {
    messageRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && status !== "sending") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, status]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim() || status === "sending") return;
    setStatus("sending");
    setError(null);
    try {
      const res = await fetch("/api/help/support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: subject.trim(), message: message.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Couldn't send your message.");
      setStatus("sent");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Couldn't send your message.");
    }
  }

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={() => status !== "sending" && onClose()}
        className="absolute inset-0 cursor-default bg-slate-900/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full max-w-md rounded-[--radius-panel] border border-border bg-surface shadow-xl"
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 id={titleId} className="text-base font-semibold text-brand-900">
            Contact support
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded p-1 text-muted-500 hover:bg-canvas"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </header>

        {status === "sent" ? (
          <div className="p-6 text-center">
            <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
              <CheckIcon className="h-5 w-5" />
            </span>
            <p className="mt-3 text-sm font-medium text-slate-800">Message sent</p>
            <p className="mt-1 text-sm text-muted-500">
              Support will reply to your email. Thanks for reaching out.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-4 rounded-[--radius-panel] bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800"
            >
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="p-4">
            <p className="text-sm text-muted-500">
              Send a message to our support team. They&apos;ll reply to your account email.
            </p>

            <label className="mt-3 block">
              <span className="text-xs font-medium text-slate-700">
                Subject <span className="text-muted-500">(optional)</span>
              </span>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                maxLength={200}
                placeholder="What do you need help with?"
                className="mt-1 w-full rounded-[--radius-panel] border border-border bg-canvas px-3 py-2 text-sm text-slate-800 placeholder:text-muted-500 focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/25"
              />
            </label>

            <label className="mt-3 block">
              <span className="text-xs font-medium text-slate-700">Message</span>
              <textarea
                ref={messageRef}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                maxLength={MAX_MESSAGE}
                rows={5}
                required
                placeholder="Describe your issue or question…"
                className="mt-1 w-full resize-y rounded-[--radius-panel] border border-border bg-canvas px-3 py-2 text-sm text-slate-800 placeholder:text-muted-500 focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/25"
              />
            </label>

            {status === "error" && error && (
              <p className="mt-2 text-sm text-red-600" role="alert">
                {error}
              </p>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={status === "sending"}
                className="rounded-[--radius-panel] border border-border px-3 py-2 text-sm font-medium text-slate-700 hover:bg-canvas disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={status === "sending" || !message.trim()}
                className="rounded-[--radius-panel] bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-50"
              >
                {status === "sending" ? "Sending…" : "Send message"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
