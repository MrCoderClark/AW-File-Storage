"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { US_STATE_OPTIONS } from "@/lib/signature-brand";

// Manage the org's per-state signature branding (spec 0009 follow-up). Each
// state's row holds Facebook / X / Instagram URLs plus an optional logo; the
// signature generator picks the row matching a card's state (falling back to the
// built-in defaults). Owner/admin only — the API re-checks. URL fields are
// pick-or-type; the logo can be uploaded or reused from another state (so the
// same image is stored once, not per state).

interface Row {
  state: string;
  facebook: string | null;
  x: string | null;
  instagram: string | null;
  logoUrl: string | null;
  updatedAt: string;
}

interface Form {
  state: string;
  facebook: string;
  x: string;
  instagram: string;
}

// What to do with the logo when the form is saved.
type LogoAction =
  | { kind: "keep" } // leave the state's current logo as-is
  | { kind: "clear" } // drop it → signature uses the built-in default
  | { kind: "reuse"; url: string } // point at a logo already uploaded
  | { kind: "upload"; file: File; preview: string }; // upload a new file

const EMPTY: Form = { state: "", facebook: "", x: "", instagram: "" };
const STATE_NAME = new Map(US_STATE_OPTIONS.map((s) => [s.abbr, s.name]));

function stateLabel(state: string): string {
  return state === "*" ? "Org-wide default" : (STATE_NAME.get(state) ?? state);
}

export function RegionalSocialLinksSection() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY);
  const [editing, setEditing] = useState(false); // editing an existing state (state field locked)
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteState, setDeleteState] = useState<string | null>(null);
  // Logo editing lives in the form: the state's saved logo + the pending change.
  const [currentLogo, setCurrentLogo] = useState<string | null>(null);
  const [logoAction, setLogoAction] = useState<LogoAction>({ kind: "keep" });
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setError(false);
    try {
      const res = await fetch("/api/social-links", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { links: Row[] };
      setRows(body.links);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Distinct stored URLs per platform, offered in each field's dropdown.
  const options = useMemo(() => {
    const fb = new Set<string>();
    const x = new Set<string>();
    const ig = new Set<string>();
    for (const r of rows ?? []) {
      if (r.facebook) fb.add(r.facebook);
      if (r.x) x.add(r.x);
      if (r.instagram) ig.add(r.instagram);
    }
    return { fb: [...fb], x: [...x], ig: [...ig] };
  }, [rows]);

  // The library of already-uploaded logos, deduped by URL, with the states using
  // each — so an admin can reuse one instead of uploading it again.
  const logoLibrary = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const r of rows ?? []) {
      if (r.logoUrl) map.set(r.logoUrl, [...(map.get(r.logoUrl) ?? []), r.state]);
    }
    return [...map.entries()].map(([url, states]) => ({ url, states }));
  }, [rows]);

  const configured = new Set((rows ?? []).map((r) => r.state));
  // States available to add (not yet configured); "*" offered when no default row.
  const addableStates = US_STATE_OPTIONS.filter((s) => !configured.has(s.abbr));

  // Drop a pending upload's object URL so we don't leak it.
  const releasePreview = useCallback(() => {
    setLogoAction((prev) => {
      if (prev.kind === "upload") URL.revokeObjectURL(prev.preview);
      return prev;
    });
  }, []);

  function startNew() {
    releasePreview();
    setEditing(false);
    setForm(EMPTY);
    setCurrentLogo(null);
    setLogoAction({ kind: "keep" });
    setFormError(null);
  }
  function startEdit(r: Row) {
    releasePreview();
    setEditing(true);
    setForm({
      state: r.state,
      facebook: r.facebook ?? "",
      x: r.x ?? "",
      instagram: r.instagram ?? "",
    });
    setCurrentLogo(r.logoUrl);
    setLogoAction({ kind: "keep" });
    setFormError(null);
  }

  // The logo shown in the form preview, reflecting the pending change.
  const logoPreview =
    logoAction.kind === "upload"
      ? logoAction.preview
      : logoAction.kind === "reuse"
        ? logoAction.url
        : logoAction.kind === "clear"
          ? null
          : currentLogo;
  // The URL currently selected (for highlighting the reuse gallery).
  const selectedLogoUrl =
    logoAction.kind === "reuse"
      ? logoAction.url
      : logoAction.kind === "keep"
        ? currentLogo
        : null;

  function pickUpload(file: File) {
    releasePreview();
    setLogoAction({ kind: "upload", file, preview: URL.createObjectURL(file) });
  }
  function pickReuse(url: string) {
    releasePreview();
    setLogoAction({ kind: "reuse", url });
  }
  function pickClear() {
    releasePreview();
    setLogoAction({ kind: "clear" });
  }
  function pickKeep() {
    releasePreview();
    setLogoAction({ kind: "keep" });
  }

  // Apply the pending logo change to a saved state's row.
  async function applyLogo(state: string) {
    const path = `/api/social-links/${encodeURIComponent(state)}/logo`;
    if (logoAction.kind === "upload") {
      const fd = new FormData();
      fd.append("logo", logoAction.file);
      const res = await fetch(path, { method: "POST", body: fd });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "Logo upload failed.");
      }
    } else if (logoAction.kind === "reuse") {
      const res = await fetch(path, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logoUrl: logoAction.url }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "Couldn't set the logo.");
      }
    } else if (logoAction.kind === "clear" && currentLogo) {
      const res = await fetch(path, { method: "DELETE" });
      if (!res.ok) throw new Error("Couldn't remove the logo.");
    }
  }

  async function save() {
    if (!form.state) {
      setFormError("Choose a state.");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const res = await fetch("/api/social-links", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "Couldn't save.");
      }
      await applyLogo(form.state);
      startNew();
      await load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(state: string) {
    setBusy(true);
    try {
      await fetch(`/api/social-links/${encodeURIComponent(state)}`, {
        method: "DELETE",
      });
      if (editing && form.state === state) startNew();
      await load();
    } finally {
      setBusy(false);
      setDeleteState(null);
    }
  }

  async function seed() {
    setBusy(true);
    try {
      await fetch("/api/social-links/seed", { method: "POST" });
      await load();
    } finally {
      setBusy(false);
    }
  }

  const setField = (key: keyof Form) => (v: string) =>
    setForm((prev) => ({ ...prev, [key]: v }));

  return (
    <section className="rounded-[--radius-panel] border border-border bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-brand-900">
            Regional social links
          </h2>
          <p className="mt-1 text-sm text-muted-500">
            The Facebook, X, and Instagram links and the logo a printable
            signature uses, chosen by the card&apos;s state. States without a row
            fall back to the built-in defaults.
          </p>
        </div>
        {rows !== null && rows.length === 0 && !error && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void seed()}
            className="shrink-0 rounded-[--radius-panel] border border-border px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-canvas disabled:opacity-50"
          >
            Load built-in defaults
          </button>
        )}
      </div>

      {/* List */}
      <div className="mt-4">
        {error ? (
          <div className="rounded-[--radius-panel] border border-border p-6 text-center text-sm text-muted-500">
            <p>Couldn&apos;t load the list.</p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-2 rounded-[--radius-panel] border border-border px-3 py-1 text-xs font-medium hover:bg-canvas"
            >
              Retry
            </button>
          </div>
        ) : rows === null ? (
          <div className="h-16 animate-pulse rounded-[--radius-panel] bg-canvas" />
        ) : rows.length === 0 ? (
          <p className="rounded-[--radius-panel] border border-dashed border-border p-6 text-center text-sm text-muted-500">
            No states configured yet — add one below, or load the built-in
            defaults.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px] text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-500">
                  <th scope="col" className="py-2 pr-3 font-medium">State</th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    <PlatformLabel platform="facebook" label="Facebook" />
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    <PlatformLabel platform="x" label="X" />
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    <PlatformLabel platform="instagram" label="Instagram" />
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">Logo</th>
                  <th scope="col" className="py-2 pl-3 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.state} className="align-top">
                    <td className="py-2.5 pr-3 font-medium text-slate-800 whitespace-nowrap">
                      {stateLabel(r.state)}
                    </td>
                    <Cell url={r.facebook} />
                    <Cell url={r.x} />
                    <Cell url={r.instagram} />
                    <td className="px-3 py-2.5">
                      {r.logoUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={r.logoUrl}
                          alt=""
                          className="h-8 w-auto max-w-[72px] rounded border border-border bg-white object-contain"
                        />
                      ) : (
                        <span className="text-xs text-muted-500">Default</span>
                      )}
                    </td>
                    <td className="py-2.5 pl-3 whitespace-nowrap text-right">
                      <button
                        type="button"
                        onClick={() => startEdit(r)}
                        className="rounded border border-border px-2 py-1 text-xs font-medium hover:bg-canvas"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteState(r.state)}
                        className="ml-2 rounded border border-red-200 px-2 py-1 text-xs font-medium text-danger-600 hover:bg-red-50"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add / edit form */}
      <div className="mt-5 rounded-[--radius-panel] border border-border bg-canvas p-4">
        <h3 className="text-sm font-semibold text-slate-800">
          {editing ? `Edit ${stateLabel(form.state)}` : "Add a state"}
        </h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-slate-700">State</span>
            {editing ? (
              <input
                value={stateLabel(form.state)}
                disabled
                className="rounded-[--radius-panel] border border-border bg-surface px-3 py-2 text-sm text-muted-500"
              />
            ) : (
              <select
                value={form.state}
                onChange={(e) => setField("state")(e.target.value)}
                className="rounded-[--radius-panel] border border-border bg-surface px-3 py-2 text-sm focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/25"
              >
                <option value="">Choose a state…</option>
                {!configured.has("*") && (
                  <option value="*">Org-wide default</option>
                )}
                {addableStates.map((s) => (
                  <option key={s.abbr} value={s.abbr}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </label>
          <UrlField
            platform="facebook"
            label="Facebook"
            listId="fb-options"
            value={form.facebook}
            onChange={setField("facebook")}
            options={options.fb}
          />
          <UrlField
            platform="x"
            label="X"
            listId="x-options"
            value={form.x}
            onChange={setField("x")}
            options={options.x}
          />
          <UrlField
            platform="instagram"
            label="Instagram"
            listId="ig-options"
            value={form.instagram}
            onChange={setField("instagram")}
            options={options.ig}
          />
        </div>

        {/* Logo: upload a new one, or reuse one already uploaded (stored once). */}
        <div className="mt-4 flex flex-col gap-2">
          <span className="text-xs font-medium text-slate-700">Signature logo</span>
          <div className="flex items-start gap-4">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-[--radius-panel] border border-border bg-surface p-1">
              {logoPreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={logoPreview}
                  alt=""
                  className="max-h-full max-w-full object-contain"
                />
              ) : (
                <span className="text-center text-[10px] leading-tight text-muted-500">
                  Built-in
                  <br />
                  default
                </span>
              )}
            </div>
            <div className="flex flex-1 flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="rounded-[--radius-panel] border border-border bg-surface px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-canvas"
                >
                  Upload new…
                </button>
                {logoPreview && (
                  <button
                    type="button"
                    onClick={pickClear}
                    className="rounded-[--radius-panel] border border-border bg-surface px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-canvas"
                  >
                    Use built-in default
                  </button>
                )}
                {logoAction.kind !== "keep" && (
                  <button
                    type="button"
                    onClick={pickKeep}
                    className="text-xs text-muted-500 hover:underline"
                  >
                    Reset
                  </button>
                )}
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) pickUpload(f);
                    e.target.value = "";
                  }}
                />
              </div>

              {logoLibrary.length > 0 && (
                <div>
                  <p className="text-xs text-muted-500">
                    Or reuse a logo you&apos;ve already uploaded:
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    {logoLibrary.map(({ url, states }) => {
                      const selected = selectedLogoUrl === url;
                      return (
                        <button
                          key={url}
                          type="button"
                          onClick={() => pickReuse(url)}
                          title={`Used by ${states.map(stateLabel).join(", ")}`}
                          className={`flex h-11 w-14 items-center justify-center overflow-hidden rounded border bg-surface p-1 ${
                            selected
                              ? "border-accent-500 ring-2 ring-accent-500/30"
                              : "border-border hover:border-slate-300"
                          }`}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={url}
                            alt=""
                            className="max-h-full max-w-full object-contain"
                          />
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <p className="text-xs text-muted-500">
                Reusing points this state at an image you&apos;ve already
                uploaded — it isn&apos;t stored again. PNG or JPEG, up to 1&nbsp;MB.
              </p>
            </div>
          </div>
        </div>

        {formError && (
          <p role="alert" className="mt-2 text-sm text-danger-600">
            {formError}
          </p>
        )}

        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="rounded-[--radius-panel] bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-60"
          >
            {busy ? "Saving…" : editing ? "Save changes" : "Add state"}
          </button>
          {editing && (
            <button
              type="button"
              disabled={busy}
              onClick={startNew}
              className="rounded-[--radius-panel] border border-border px-4 py-2 text-sm font-medium text-slate-700 hover:bg-canvas"
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={deleteState !== null}
        title={`Remove ${deleteState ? stateLabel(deleteState) : ""}?`}
        body="Signatures for cards in this state will fall back to the built-in defaults."
        confirmLabel="Remove"
        danger
        busy={busy}
        onCancel={() => setDeleteState(null)}
        onConfirm={() => deleteState && void remove(deleteState)}
      />
    </section>
  );
}

type Platform = "facebook" | "x" | "instagram";

// The hosted round icon for a platform (same asset the signature uses).
function PlatformIcon({ platform }: { platform: Platform }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/social/${platform}.png`}
      alt=""
      width={14}
      height={14}
      className="inline-block h-3.5 w-3.5 shrink-0 rounded-full align-middle"
    />
  );
}

function PlatformLabel({ platform, label }: { platform: Platform; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <PlatformIcon platform={platform} />
      {label}
    </span>
  );
}

function Cell({ url }: { url: string | null }) {
  return (
    <td className="px-3 py-2.5 text-muted-500">
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="block max-w-[22ch] truncate text-accent-500 hover:underline"
          title={url}
        >
          {url}
        </a>
      ) : (
        <span aria-hidden>—</span>
      )}
    </td>
  );
}

function UrlField({
  platform,
  label,
  listId,
  value,
  onChange,
  options,
}: {
  platform: Platform;
  label: string;
  listId: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-slate-700">
        <PlatformLabel platform={platform} label={`${label} URL`} />
      </span>
      <input
        type="url"
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="https://…"
        className="rounded-[--radius-panel] border border-border bg-surface px-3 py-2 text-sm focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/25"
      />
      <datalist id={listId}>
        {options.map((u) => (
          <option key={u} value={u} />
        ))}
      </datalist>
    </label>
  );
}
