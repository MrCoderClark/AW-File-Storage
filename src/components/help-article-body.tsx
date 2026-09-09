"use client";

import { useEffect, useRef } from "react";

// Renders the sanitized article HTML and, at runtime, injects a "Copy" button onto every
// <pre> code block (spec 0025 AC-7). The stored/served HTML stays static and sanitized —
// nothing is ever added to body_html; the button is a DOM node created here on the client.

export function HelpArticleBody({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const cleanups: Array<() => void> = [];

    for (const pre of Array.from(root.querySelectorAll("pre"))) {
      if (pre.dataset.copyReady) continue;
      pre.dataset.copyReady = "1";

      // Capture the code text BEFORE the button is appended, so it isn't included.
      const text = (pre.querySelector("code") ?? pre).textContent ?? "";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "help-copy-btn";
      btn.textContent = "Copy";
      btn.setAttribute("aria-label", "Copy code");

      let resetTimer: ReturnType<typeof setTimeout> | undefined;
      const onClick = () => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            btn.textContent = "Copied";
          })
          .catch(() => {
            btn.textContent = "Failed";
          })
          .finally(() => {
            clearTimeout(resetTimer);
            resetTimer = setTimeout(() => {
              btn.textContent = "Copy";
            }, 1500);
          });
      };

      btn.addEventListener("click", onClick);
      pre.appendChild(btn);

      cleanups.push(() => {
        clearTimeout(resetTimer);
        btn.removeEventListener("click", onClick);
        btn.remove();
        delete pre.dataset.copyReady;
      });
    }

    return () => {
      for (const c of cleanups) c();
    };
  }, [html]);

  return (
    <div
      ref={ref}
      className="help-content mt-6"
      // Sanitized on save and again on the server before this renders (spec 0024 AC-8).
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
