"use client";

import { useEffect, useState } from "react";

// "Was this helpful?" plus a one-time view ping (spec 0026 polish). On mount it counts a view
// (once per browser tab session), then offers Yes / No; a vote is remembered per browser so the
// same reader can't stuff the counter. Purely additive to the article page.

export function HelpFeedback({ articleId }: { articleId: string }) {
  const [voted, setVoted] = useState<null | "up" | "down">(null);
  const [busy, setBusy] = useState(false);

  // View ping: once per tab session per article (avoids double counts on re-render/StrictMode).
  useEffect(() => {
    const key = `help-viewed:${articleId}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {
      // sessionStorage unavailable: still ping once per mount.
    }
    void fetch(`/api/help/articles/${articleId}/view`, { method: "POST" }).catch(
      () => {},
    );
  }, [articleId]);

  // Reflect a prior vote from this browser.
  useEffect(() => {
    try {
      const prior = localStorage.getItem(`help-vote:${articleId}`);
      if (prior === "up" || prior === "down") setVoted(prior);
    } catch {
      // ignore
    }
  }, [articleId]);

  async function vote(helpful: boolean) {
    if (voted || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/help/articles/${articleId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ helpful }),
      });
      if (res.ok) {
        const value = helpful ? "up" : "down";
        setVoted(value);
        try {
          localStorage.setItem(`help-vote:${articleId}`, value);
        } catch {
          // ignore
        }
      }
    } finally {
      setBusy(false);
    }
  }

  if (voted) {
    return (
      <div className="mt-10 border-t border-border pt-5 text-sm text-muted-500">
        Thanks for your feedback.
      </div>
    );
  }

  return (
    <div className="mt-10 flex flex-wrap items-center gap-3 border-t border-border pt-5">
      <span className="text-sm font-medium text-slate-700">Was this helpful?</span>
      <button
        type="button"
        onClick={() => void vote(true)}
        disabled={busy}
        className="rounded-[--radius-panel] border border-border px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-canvas disabled:opacity-50"
      >
        👍 Yes
      </button>
      <button
        type="button"
        onClick={() => void vote(false)}
        disabled={busy}
        className="rounded-[--radius-panel] border border-border px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-canvas disabled:opacity-50"
      >
        👎 No
      </button>
    </div>
  );
}
