"use client";

import Link from "next/link";
import { useState } from "react";
import { useAppData } from "@/components/app-data";
import { buildVcard, type CardFields, cardFileName } from "@/lib/vcard-builder";

const EMPTY: CardFields = {
  firstName: "",
  lastName: "",
  fullName: "",
  email: "",
  mobilePhone: "",
  workPhone: "",
  fax: "",
  organization: "",
  jobTitle: "",
  street: "",
  city: "",
  state: "",
  zip: "",
  country: "USA",
  website: "",
};

const STEPS = ["Name & contact", "Work", "Address"] as const;
const LAST = STEPS.length - 1;

/** Capitalise the first letter of each word, leaving the rest as typed. */
function titleCase(s: string): string {
  return s.replace(/(^|[\s'-])(\p{L})/gu, (_, sep, ch: string) => sep + ch.toUpperCase());
}

type Status = "idle" | "publishing" | "done" | "error";

// Create Card page (spec 0006): a 3-step wizard that builds a vCard 3.0 in the
// browser and publishes it through the normal upload pipeline. Field values
// persist across steps (single state object), so Back never loses input.
export function CreateCardForm() {
  const { refresh } = useAppData();
  const [f, setF] = useState<CardFields>(EMPTY);
  // Auto-fill Full name from First + Last until the user edits it themselves.
  const [fullNameTouched, setFullNameTouched] = useState(false);
  const [step, setStep] = useState(0);
  const [stepError, setStepError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [fileId, setFileId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const set =
    (key: keyof CardFields) => (e: React.ChangeEvent<HTMLInputElement>) => {
      setF((prev) => ({ ...prev, [key]: e.target.value }));
    };

  const derived = (first: string, last: string) =>
    [first.trim(), last.trim()].filter(Boolean).join(" ");

  const setFirst = (e: React.ChangeEvent<HTMLInputElement>) => {
    const firstName = e.target.value;
    setF((prev) => ({
      ...prev,
      firstName,
      fullName: fullNameTouched ? prev.fullName : derived(firstName, prev.lastName),
    }));
  };
  const setLast = (e: React.ChangeEvent<HTMLInputElement>) => {
    const lastName = e.target.value;
    setF((prev) => ({
      ...prev,
      lastName,
      fullName: fullNameTouched ? prev.fullName : derived(prev.firstName, lastName),
    }));
  };
  const setFull = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fullName = e.target.value;
    // Empty again → resume auto-fill; otherwise the user owns it.
    setFullNameTouched(fullName.trim() !== "");
    setF((prev) => ({ ...prev, fullName }));
  };

  // Title-case a value on blur (capitalise the first letter of each word,
  // leaving the rest as typed so "McDonald" survives).
  type TextKey =
    | "firstName"
    | "lastName"
    | "fullName"
    | "organization"
    | "jobTitle"
    | "street"
    | "city"
    | "country";
  const capitalize = (key: TextKey) => () => {
    setF((prev) => {
      const updated = { ...prev, [key]: titleCase(prev[key] ?? "") };
      if ((key === "firstName" || key === "lastName") && !fullNameTouched) {
        updated.fullName = derived(updated.firstName, updated.lastName);
      }
      return updated;
    });
  };

  function validateStep0(): string | null {
    if (!f.firstName.trim() || !f.lastName.trim()) {
      return "First and last name are required.";
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim())) {
      return "A valid email is required.";
    }
    return null;
  }

  function next() {
    if (step === 0) {
      const err = validateStep0();
      if (err) {
        setStepError(err);
        return;
      }
    }
    setStepError(null);
    setStep((s) => Math.min(s + 1, LAST));
  }

  function back() {
    setStepError(null);
    setStep((s) => Math.max(s - 1, 0));
  }

  async function publish(
    file: File,
  ): Promise<{ publicUrl: string | null; fileId: string | null }> {
    const res = await fetch("/api/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: file.name,
        size: file.size,
        contentType: file.type || "text/vcard",
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? "The card was rejected.");
    }
    const { uploadSessionId, url } = (await res.json()) as {
      uploadSessionId: string;
      url: string;
    };
    const put = await fetch(url, { method: "PUT", body: file });
    if (!put.ok) throw new Error(`Upload failed (${put.status}).`);
    const fin = await fetch("/api/uploads/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadSessionId }),
    });
    if (!fin.ok) {
      const body = (await fin.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? "Publishing failed.");
    }
    const result = (await fin.json()) as {
      publicUrl?: string;
      fileId?: string;
    };
    return { publicUrl: result.publicUrl ?? null, fileId: result.fileId ?? null };
  }

  // Form submit only ever ADVANCES a step (covers Enter in a field). Publishing
  // is deliberately not triggered here, so Enter never publishes — only an
  // explicit click on "Create & publish" does.
  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (step !== LAST) next();
  }

  async function doPublish() {
    setStatus("publishing");
    setError(null);
    setPublicUrl(null);
    setFileId(null);
    try {
      const file = new File([buildVcard(f)], cardFileName(f), {
        type: "text/vcard",
      });
      const { publicUrl: url, fileId: fid } = await publish(file);
      setPublicUrl(url);
      setFileId(fid);
      setStatus("done");
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setStatus("error");
    }
  }

  if (status === "done") {
    return (
      <div className="rounded-[--radius-drop] border border-border bg-surface p-6 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
          <CheckIcon className="h-6 w-6" />
        </div>
        <h2 className="mt-3 text-lg font-semibold text-brand-900">
          Card published
        </h2>
        {publicUrl ? (
          <>
            <p className="mt-1 text-sm text-muted-500">
              Its public address (safe to print behind a QR code):
            </p>
            <PublicUrl url={publicUrl} />
          </>
        ) : (
          <p className="mt-1 text-sm text-muted-500">
            The card was saved and published.
          </p>
        )}
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          {fileId && (
            <Link
              href={`/signature/${fileId}`}
              className="rounded-[--radius-panel] bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-800"
            >
              Create signature
            </Link>
          )}
          <button
            type="button"
            onClick={() => {
              setF(EMPTY);
              setFullNameTouched(false);
              setStep(0);
              setStatus("idle");
              setPublicUrl(null);
              setFileId(null);
            }}
            className={`rounded-[--radius-panel] px-5 py-2 text-sm font-semibold ${
              fileId
                ? "border border-border text-slate-700 hover:bg-canvas"
                : "bg-brand-600 text-white hover:bg-brand-800"
            }`}
          >
            Create another
          </button>
        </div>
      </div>
    );
  }

  const busy = status === "publishing";

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-[--radius-drop] border border-border bg-surface p-5 sm:p-6"
    >
      <Stepper current={step} />

      {step === 0 && (
        <FieldGrid>
          <Field label="First name" required value={f.firstName} onChange={setFirst} onBlur={capitalize("firstName")} />
          <Field label="Last name" required value={f.lastName} onChange={setLast} onBlur={capitalize("lastName")} />
          <Field
            label="Full name"
            value={f.fullName ?? ""}
            onChange={setFull}
            onBlur={capitalize("fullName")}
          />
          <Field label="Email" type="email" required value={f.email} onChange={set("email")} />
          <Field label="Mobile phone" type="tel" value={f.mobilePhone ?? ""} onChange={set("mobilePhone")} />
        </FieldGrid>
      )}

      {step === 1 && (
        <FieldGrid>
          <Field label="Organization" value={f.organization ?? ""} onChange={set("organization")} onBlur={capitalize("organization")} />
          <Field label="Job title" value={f.jobTitle ?? ""} onChange={set("jobTitle")} onBlur={capitalize("jobTitle")} />
          <Field label="Work phone" type="tel" value={f.workPhone ?? ""} onChange={set("workPhone")} />
          <Field label="Fax" type="tel" value={f.fax ?? ""} onChange={set("fax")} />
          <Field label="Website" type="url" value={f.website ?? ""} onChange={set("website")} className="sm:col-span-2" />
        </FieldGrid>
      )}

      {step === 2 && (
        <FieldGrid>
          <Field label="Street" value={f.street ?? ""} onChange={set("street")} onBlur={capitalize("street")} className="sm:col-span-2" />
          <Field label="City" value={f.city ?? ""} onChange={set("city")} onBlur={capitalize("city")} />
          <Field label="State" value={f.state ?? ""} onChange={set("state")} />
          <Field label="Zip" value={f.zip ?? ""} onChange={set("zip")} />
          <Field label="Country" value={f.country ?? ""} onChange={set("country")} onBlur={capitalize("country")} />
        </FieldGrid>
      )}

      {stepError && (
        <p role="alert" className="mt-4 text-sm text-danger-600">
          {stepError}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-4 text-sm text-danger-600">
          {error}
        </p>
      )}

      <div className="mt-6 flex items-center justify-between">
        <button
          type="button"
          onClick={back}
          disabled={step === 0 || busy}
          className="rounded-[--radius-panel] border border-border px-4 py-2 text-sm font-medium text-slate-700 hover:bg-canvas disabled:invisible"
        >
          Back
        </button>

        {step < LAST ? (
          <button
            type="button"
            onClick={next}
            className="rounded-[--radius-panel] bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
          >
            Next
          </button>
        ) : (
          <button
            type="button"
            onClick={doPublish}
            disabled={busy}
            className="rounded-[--radius-panel] bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 disabled:opacity-60"
          >
            {busy ? "Publishing…" : "Create & publish"}
          </button>
        )}
      </div>
    </form>
  );
}

function Stepper({ current }: { current: number }) {
  return (
    <ol className="mb-5 flex items-center gap-2">
      {STEPS.map((label, i) => {
        const state =
          i < current ? "done" : i === current ? "current" : "todo";
        return (
          <li key={label} className="flex flex-1 items-center gap-2">
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${state === "current"
                  ? "bg-brand-600 text-white"
                  : state === "done"
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-canvas text-muted-500"
                }`}
            >
              {i + 1}
            </span>
            <span
              className={`hidden text-xs font-medium sm:inline ${state === "current" ? "text-slate-800" : "text-muted-500"
                }`}
            >
              {label}
            </span>
            {i < STEPS.length - 1 && (
              <span className="h-px flex-1 bg-border" aria-hidden />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function FieldGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2">{children}</div>;
}

function PublicUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mx-auto mt-3 flex max-w-md items-center gap-2 rounded-[--radius-panel] border border-border bg-canvas p-2">
      <code className="min-w-0 flex-1 truncate text-left text-xs text-accent-500">
        {url}
      </code>
      <button
        type="button"
        onClick={async () => {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="shrink-0 rounded border border-border px-2 py-0.5 text-[11px] font-medium hover:bg-surface"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  onBlur,
  type = "text",
  required = false,
  placeholder,
  className = "",
}: {
  label: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onBlur?: () => void;
  type?: string;
  required?: boolean;
  placeholder?: string;
  className?: string;
}) {
  return (
    <label className={`flex flex-col gap-1 ${className}`}>
      <span className="text-sm font-medium text-slate-700">
        {label}
        {required && <span className="text-danger-600"> *</span>}
      </span>
      <input
        type={type}
        value={value}
        onChange={onChange}
        onBlur={onBlur}
        placeholder={placeholder}
        className="rounded-[--radius-panel] border border-border bg-canvas px-3 py-2 text-sm focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/25"
      />
    </label>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden className={className}>
      <path d="m5 12 5 5L20 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
