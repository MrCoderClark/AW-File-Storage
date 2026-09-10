"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppData } from "@/components/app-data";

// Bulk contact-card import — the browser half (spec 0028, tasks 6/7/11). The Upload
// Center opens this when a .csv/.xlsx is chosen. The spreadsheet is parsed HERE, in the
// browser (the .xlsx parser is dynamically imported so it stays out of the initial
// bundle); the user maps columns to card fields and previews per-row validity; on
// confirm ONLY the mapped rows go to /api/cards/import as JSON — the raw file is never
// uploaded (AC-1..AC-4). Publishing then runs server-side; this view polls the results.

type FieldKey =
  | "firstName"
  | "lastName"
  | "fullName"
  | "jobTitle"
  | "organization"
  | "department"
  | "email"
  | "workPhone"
  | "mobilePhone"
  | "fax"
  | "street"
  | "city"
  | "state"
  | "zip"
  | "country"
  | "website";

// The card fields a column can map to, with the header names we auto-detect. Aliases
// are matched on a normalised (lower-case, alphanumeric-only) header.
const FIELDS: { key: FieldKey; label: string; aliases: string[] }[] = [
  { key: "firstName", label: "First name", aliases: ["firstname", "first", "givenname", "given"] },
  { key: "lastName", label: "Last name", aliases: ["lastname", "last", "surname", "familyname", "family"] },
  { key: "fullName", label: "Full name", aliases: ["fullname", "name", "displayname", "contactname"] },
  { key: "jobTitle", label: "Job title", aliases: ["jobtitle", "title", "position", "role"] },
  { key: "organization", label: "Organization", aliases: ["organization", "organisation", "company", "org", "employer"] },
  { key: "department", label: "Department", aliases: ["department", "dept", "division", "team"] },
  { key: "email", label: "Email", aliases: ["email", "emailaddress", "mail", "workemail"] },
  { key: "workPhone", label: "Work phone", aliases: ["workphone", "businessphone", "office", "officephone", "phone", "telephone", "tel"] },
  { key: "mobilePhone", label: "Mobile phone", aliases: ["mobilephone", "mobile", "cell", "cellphone", "cellular"] },
  { key: "fax", label: "Fax", aliases: ["fax", "faxnumber"] },
  { key: "street", label: "Street", aliases: ["street", "address", "streetaddress", "address1", "addressline1"] },
  { key: "city", label: "City", aliases: ["city", "town", "locality"] },
  { key: "state", label: "State", aliases: ["state", "province", "region"] },
  { key: "zip", label: "ZIP / Postal", aliases: ["zip", "zipcode", "postal", "postalcode", "postcode"] },
  { key: "country", label: "Country", aliases: ["country", "nation"] },
  { key: "website", label: "Website", aliases: ["website", "url", "web", "homepage", "site"] },
];

const OUTCOME_BADGE: Record<string, { label: string; className: string }> = {
  pending: { label: "Waiting", className: "bg-slate-100 text-slate-600" },
  processing: { label: "Publishing", className: "bg-accent-500/10 text-accent-500" },
  published: { label: "Published", className: "bg-emerald-100 text-emerald-700" },
  skipped: { label: "Skipped", className: "bg-amber-100 text-amber-700" },
  failed: { label: "Failed", className: "bg-red-50 text-danger-600" },
};

const TERMINAL = new Set(["completed", "completed_with_errors", "failed"]);

interface MappedRow {
  rowNumber: number;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  jobTitle?: string;
  organization?: string;
  department?: string;
  email?: string;
  workPhone?: string;
  mobilePhone?: string;
  fax?: string;
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  website?: string;
}

interface ResultRow {
  rowNumber: number;
  contactName: string | null;
  outcome: string;
  reason: string | null;
  publicUrl?: string;
}

interface ImportResult {
  status: string;
  total: number;
  published: number;
  skipped: number;
  failed: number;
  rows: ResultRow[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A minimal RFC 4180-ish CSV parser: quoted fields, escaped quotes, CRLF/CR/LF. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  // Flush the last field/row if the file didn't end with a newline.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Split parsed rows into a header row + data rows, dropping fully-blank rows. */
function toHeaderAndData(rows: string[][]): { headers: string[]; data: string[][] } {
  const nonEmpty = rows.filter((r) => r.some((c) => (c ?? "").toString().trim() !== ""));
  if (nonEmpty.length === 0) return { headers: [], data: [] };
  const headers = nonEmpty[0].map((h) => (h ?? "").toString().trim());
  return { headers, data: nonEmpty.slice(1) };
}

/** Best-effort auto-map each field to a column whose header matches an alias. */
function autoMap(headers: string[]): Record<FieldKey, number> {
  const normalized = headers.map(norm);
  const mapping = {} as Record<FieldKey, number>;
  for (const f of FIELDS) {
    const wanted = new Set([norm(f.label), ...f.aliases]);
    mapping[f.key] = normalized.findIndex((h) => h !== "" && wanted.has(h));
  }
  return mapping;
}

export function SpreadsheetImport({
  file,
  onClose,
}: {
  file: File;
  onClose: () => void;
}) {
  const { refresh } = useAppData();
  const [step, setStep] = useState<"parsing" | "mapping" | "preview" | "results">(
    "parsing",
  );
  const [parseError, setParseError] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [data, setData] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<FieldKey, number>>(
    {} as Record<FieldKey, number>,
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [importId, setImportId] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  // Escape closes the wizard (before submit; after submit the import keeps running).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Parse the chosen file in the browser (CSV inline; .xlsx via a dynamic import so
  // SheetJS is not in the initial bundle).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let rows: string[][];
        if (/\.csv$/i.test(file.name)) {
          rows = parseCsv(await file.text());
        } else {
          const XLSX = await import("xlsx");
          const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
          const sheet = wb.Sheets[wb.SheetNames[0]];
          rows = XLSX.utils.sheet_to_json<string[]>(sheet, {
            header: 1,
            blankrows: false,
            defval: "",
            raw: false,
          });
        }
        if (cancelled) return;
        const { headers: hs, data: ds } = toHeaderAndData(rows);
        if (hs.length === 0 || ds.length === 0) {
          setParseError(
            "That file has no data rows. Make sure the first row is column headers and there is at least one contact below it.",
          );
          return;
        }
        setHeaders(hs);
        setData(ds);
        setMapping(autoMap(hs));
        setStep("mapping");
      } catch {
        if (!cancelled) {
          setParseError(
            "Couldn't read that file. Please upload a .csv or .xlsx spreadsheet.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file]);

  // Build the mapped rows, dropping rows with no data in any mapped column. Row numbers
  // are the source spreadsheet rows (header is row 1, so data starts at row 2).
  const buildRows = useCallback((): MappedRow[] => {
    const out: MappedRow[] = [];
    data.forEach((row, i) => {
      const cell = (key: FieldKey): string => {
        const idx = mapping[key];
        return idx != null && idx >= 0 ? (row[idx] ?? "").toString().trim() : "";
      };
      const mapped: MappedRow = { rowNumber: i + 2 };
      let any = false;
      for (const f of FIELDS) {
        const v = cell(f.key);
        if (v) {
          mapped[f.key] = v;
          any = true;
        }
      }
      if (any) out.push(mapped);
    });
    return out;
  }, [data, mapping]);

  const rowName = (r: MappedRow): string =>
    (r.fullName || `${r.firstName ?? ""} ${r.lastName ?? ""}`).trim();

  async function submit() {
    setSubmitError(null);
    const rows = buildRows();
    const valid = rows.filter((r) => rowName(r) !== "");
    if (valid.length === 0) {
      setSubmitError(
        "No row has a usable name. Map a First/Last name or a Full name column, then try again.",
      );
      return;
    }
    setSubmitting(true);
    const id = crypto.randomUUID();
    try {
      const res = await fetch("/api/cards/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ importId: id, rows }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !body.ok) {
        setSubmitError(body.error ?? "Couldn't start the import. Please try again.");
        setSubmitting(false);
        return;
      }
      setImportId(id);
      setStep("results");
    } catch {
      setSubmitError("Couldn't reach the server. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Import contacts from a spreadsheet"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div className="relative flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-[--radius-drop] border border-border bg-surface shadow-xl">
        <header className="flex items-start justify-between border-b border-border px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-brand-900">
              Import contacts from a spreadsheet
            </h2>
            <p className="mt-0.5 truncate text-sm text-muted-500" title={file.name}>
              {file.name}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[--radius-panel] border border-border px-3 py-1 text-sm font-medium text-slate-700 hover:bg-canvas"
          >
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {step === "parsing" && (
            <p className="py-10 text-center text-sm text-muted-500">
              {parseError ? null : "Reading your spreadsheet…"}
            </p>
          )}

          {parseError && (
            <div className="rounded-[--radius-panel] border border-red-200 bg-red-50 px-4 py-3 text-sm text-danger-600">
              {parseError}
            </div>
          )}

          {step === "mapping" && (
            <MappingStep
              headers={headers}
              data={data}
              mapping={mapping}
              onChange={(key, idx) =>
                setMapping((m) => ({ ...m, [key]: idx }))
              }
            />
          )}

          {step === "preview" && (
            <PreviewStep rows={buildRows()} rowName={rowName} error={submitError} />
          )}

          {step === "results" && importId && (
            <ResultsStep
              importId={importId}
              onResult={setResult}
            />
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-border px-6 py-4">
          <div className="text-sm text-muted-500">
            {step === "mapping" && `${data.length} rows found`}
            {step === "preview" && (() => {
              const rows = buildRows();
              const valid = rows.filter((r) => rowName(r) !== "").length;
              return `${valid} of ${rows.length} ready to import`;
            })()}
            {step === "results" && result && (
              <>
                {result.published} published · {result.skipped} skipped ·{" "}
                {result.failed} failed
              </>
            )}
          </div>
          <div className="flex gap-2">
            {step === "preview" && (
              <button
                type="button"
                onClick={() => {
                  setSubmitError(null);
                  setStep("mapping");
                }}
                className="rounded-[--radius-panel] border border-border px-4 py-2 text-sm font-medium text-slate-700 hover:bg-canvas"
              >
                Back
              </button>
            )}
            {step === "mapping" && (
              <button
                type="button"
                onClick={() => {
                  setSubmitError(null);
                  setStep("preview");
                }}
                className="rounded-[--radius-panel] bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
              >
                Continue to preview
              </button>
            )}
            {step === "preview" && (
              <button
                type="button"
                onClick={submit}
                disabled={submitting}
                className="rounded-[--radius-panel] bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
              >
                {submitting ? "Starting…" : "Import contacts"}
              </button>
            )}
            {step === "results" && (
              <button
                type="button"
                onClick={() => {
                  refresh();
                  onClose();
                }}
                className="rounded-[--radius-panel] bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
              >
                Done
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

function MappingStep({
  headers,
  data,
  mapping,
  onChange,
}: {
  headers: string[];
  data: string[][];
  mapping: Record<FieldKey, number>;
  onChange: (key: FieldKey, idx: number) => void;
}) {
  return (
    <div>
      <p className="text-sm text-muted-500">
        Match your spreadsheet columns to the contact-card fields. We&apos;ve guessed
        from your headers — adjust anything that&apos;s off. A contact needs at least a
        name.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {FIELDS.map((f) => {
          const idx = mapping[f.key] ?? -1;
          const sample =
            idx >= 0 ? (data[0]?.[idx] ?? "").toString().trim() : "";
          return (
            <label key={f.key} className="block">
              <span className="text-sm font-medium text-slate-800">{f.label}</span>
              <select
                value={idx}
                onChange={(e) => onChange(f.key, Number(e.target.value))}
                className="mt-1 w-full rounded-[--radius-panel] border border-border bg-surface px-3 py-2 text-sm text-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
              >
                <option value={-1}>— Not mapped —</option>
                {headers.map((h, i) => (
                  <option key={i} value={i}>
                    {h || `Column ${i + 1}`}
                  </option>
                ))}
              </select>
              {sample && (
                <span className="mt-0.5 block truncate text-xs text-muted-500">
                  e.g. {sample}
                </span>
              )}
            </label>
          );
        })}
      </div>
    </div>
  );
}

function PreviewStep({
  rows,
  rowName,
  error,
}: {
  rows: MappedRow[];
  rowName: (r: MappedRow) => string;
  error: string | null;
}) {
  // Only the first slice is rendered — a 200-row sheet would otherwise be an
  // unusable wall of rows. The full count is shown below the table, and every row
  // is still validated and imported on confirm (this is a display cap only).
  const PREVIEW_LIMIT = 20;
  const shown = rows.slice(0, PREVIEW_LIMIT);
  const hidden = rows.length - shown.length;
  return (
    <div>
      {error && (
        <div className="mb-4 rounded-[--radius-panel] border border-red-200 bg-red-50 px-4 py-2 text-sm text-danger-600">
          {error}
        </div>
      )}
      <p className="text-sm text-muted-500">
        Review the contacts below. Rows without a name can&apos;t become a card and will
        be skipped; the rest publish. Nothing is published until you confirm.
      </p>
      <div className="mt-4 max-h-[46vh] overflow-auto rounded-[--radius-panel] border border-border">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-canvas text-xs uppercase tracking-wide text-muted-500">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Row</th>
              <th scope="col" className="px-3 py-2 font-medium">Name</th>
              <th scope="col" className="px-3 py-2 font-medium">Email</th>
              <th scope="col" className="px-3 py-2 font-medium">Organization</th>
              <th scope="col" className="px-3 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {shown.map((r) => {
              const name = rowName(r);
              const ok = name !== "";
              return (
                <tr key={r.rowNumber} className="align-top">
                  <td className="px-3 py-2 text-muted-500">{r.rowNumber}</td>
                  <td className="px-3 py-2 font-medium text-slate-800">
                    {name || <span className="text-danger-600">No name</span>}
                  </td>
                  <td className="px-3 py-2 text-muted-500">{r.email ?? ""}</td>
                  <td className="px-3 py-2 text-muted-500">{r.organization ?? ""}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        ok
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-amber-100 text-amber-700"
                      }`}
                    >
                      {ok ? "Ready" : "Skip (no name)"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {hidden > 0 && (
        <p className="mt-2 text-xs text-muted-500">
          Showing the first {shown.length} of {rows.length} contacts. All{" "}
          {rows.length} will be imported when you confirm.
        </p>
      )}
    </div>
  );
}

function ResultsStep({
  importId,
  onResult,
}: {
  importId: string;
  onResult: (r: ImportResult) => void;
}) {
  const [res, setRes] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await fetch(`/api/cards/import/${importId}`);
        const body = (await r.json().catch(() => ({}))) as
          | ({ ok: true } & ImportResult)
          | { ok?: false; error?: string };
        if (cancelled) return;
        if (r.ok && "status" in body) {
          const next: ImportResult = {
            status: body.status,
            total: body.total,
            published: body.published,
            skipped: body.skipped,
            failed: body.failed,
            rows: body.rows,
          };
          setRes(next);
          onResult(next);
          if (!TERMINAL.has(next.status)) {
            timer.current = setTimeout(poll, 1500);
          }
        } else {
          setError("Couldn't load the import status.");
        }
      } catch {
        if (!cancelled) timer.current = setTimeout(poll, 2500);
      }
    };
    poll();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [importId, onResult]);

  if (error) {
    return (
      <div className="rounded-[--radius-panel] border border-red-200 bg-red-50 px-4 py-3 text-sm text-danger-600">
        {error}
      </div>
    );
  }
  if (!res) {
    return <p className="py-10 text-center text-sm text-muted-500">Starting import…</p>;
  }

  const settled = TERMINAL.has(res.status);
  const done = res.published + res.skipped + res.failed;
  const pct = res.total > 0 ? Math.round((done / res.total) * 100) : 100;

  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-slate-800">
          {settled
            ? "Import complete"
            : `Publishing… ${done} of ${res.total}`}
        </span>
        <span className="text-muted-500">
          {res.published} published · {res.skipped} skipped · {res.failed} failed
        </span>
      </div>
      <div
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-canvas"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Import progress"
      >
        <div
          className="h-full rounded-full bg-accent-500 transition-[width]"
          style={{ width: `${pct}%` }}
        />
      </div>
      {!settled && (
        <p className="mt-2 text-xs text-muted-500">
          You can close this window — the import keeps running and your cards will appear
          on the Files page.
        </p>
      )}

      <div className="mt-4 max-h-[42vh] overflow-auto rounded-[--radius-panel] border border-border">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-canvas text-xs uppercase tracking-wide text-muted-500">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Row</th>
              <th scope="col" className="px-3 py-2 font-medium">Name</th>
              <th scope="col" className="px-3 py-2 font-medium">Result</th>
              <th scope="col" className="px-3 py-2 font-medium">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {res.rows.map((row) => {
              const badge = OUTCOME_BADGE[row.outcome] ?? OUTCOME_BADGE.pending;
              return (
                <tr key={row.rowNumber} className="align-top">
                  <td className="px-3 py-2 text-muted-500">{row.rowNumber}</td>
                  <td className="px-3 py-2 font-medium text-slate-800">
                    {row.contactName ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${badge.className}`}
                    >
                      {badge.label}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-muted-500">
                    {row.outcome === "published" && row.publicUrl ? (
                      <a
                        href={row.publicUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-accent-500 hover:underline"
                      >
                        View card
                      </a>
                    ) : (
                      (row.reason ?? "")
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
