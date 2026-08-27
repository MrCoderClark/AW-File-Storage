// Upload Center — the default landing (spec 0004). This is the static shell of
// the main panel; the drag-and-drop, upload queue, and file table are wired to
// the API in sub-step 4b.
export default function UploadCenterPage() {
  return (
    <div className="mx-auto max-w-3xl">
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

      <div className="mt-6 rounded-[--radius-drop] border-2 border-dashed border-border bg-surface px-6 py-12 text-center">
        <p className="text-sm text-muted-500">
          Drag &amp; drop files or folders here to upload
        </p>
        <button
          type="button"
          disabled
          className="mt-4 rounded-[--radius-panel] bg-brand-600 px-4 py-2 text-sm font-medium text-white opacity-60"
        >
          Browse files
        </button>
      </div>

      <div className="mt-6 rounded-[--radius-panel] border border-border bg-surface p-8 text-center text-sm text-muted-500">
        Nothing uploading. Drop a file to start.
      </div>
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
