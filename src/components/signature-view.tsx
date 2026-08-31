"use client";

import Link from "next/link";
import { useState } from "react";

// Printable signature page (spec 0009). The signature markup is built on the
// server (email-safe table HTML) and passed in as a string; this component
// presents it and prints it. The toolbar and helper notes carry `print:hidden`
// so a print / Save-as-PDF captures the signature alone.
export function SignatureView({
  name,
  fullName,
  publicUrl,
  html,
}: {
  name: string;
  fullName: string;
  publicUrl: string;
  html: string;
}) {
  const [copiedUrl, setCopiedUrl] = useState(false);

  async function copyUrl() {
    await navigator.clipboard.writeText(publicUrl);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 2000);
  }

  return (
    <div className="print:p-0">
      <div className="mx-auto max-w-3xl print:max-w-none">
        <div className="print:hidden">
          <Link
            href="/files"
            className="text-sm font-medium text-accent-500 hover:underline"
          >
            ← Back to files
          </Link>
          <h1 className="mt-3 text-2xl font-semibold text-brand-900">
            Signature for {fullName || name}
          </h1>
          <p className="mt-1 text-sm text-muted-500">
            Print it or save it as a PDF. The QR code and logo are hosted, so
            they resolve wherever the signature is shared.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => window.print()}
              className="rounded-[--radius-panel] bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
            >
              Print / Save as PDF
            </button>
            <button
              type="button"
              onClick={() => void copyUrl()}
              className="rounded-[--radius-panel] border border-border bg-surface px-4 py-2 text-sm font-medium text-slate-700 hover:bg-canvas"
            >
              {copiedUrl ? "Copied ✓" : "Copy public link"}
            </button>
          </div>
        </div>

        {/* The signature itself — the only thing that prints. */}
        <div className="mt-6 rounded-[--radius-panel] border border-border bg-white p-6 shadow-sm print:mt-0 print:border-0 print:p-0 print:shadow-none">
          {/* eslint-disable-next-line react/no-danger */}
          <div dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      </div>
    </div>
  );
}
