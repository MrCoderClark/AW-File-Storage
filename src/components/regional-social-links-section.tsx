"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { US_STATE_OPTIONS } from "@/lib/signature-brand";

// Manage the org's per-state signature social links (spec 0009 follow-up). Each
// state's row holds Facebook / X / Instagram URLs; the signature generator picks
// the row matching a card's state (falling back to the built-in defaults). Owner/
// admin only — the API re-checks. URL fields are pick-or-type: the dropdown lists
// URLs already stored, so admins reuse them or add new ones.

interface Row {
  state: string;
  facebook: string | null;
  x: string | null;
  instagram: string | null;
  updatedAt: string;
}

interface Form {
  state: string;
  facebook: string;
  x: string;
  instagram: string;
}

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

  const configured = new Set((rows ?? []).map((r) => r.state));
  // States available to add (not yet configured); "*" offered when no default row.
  const addableStates = US_STATE_OPTIONS.filter((s) => !configured.has(s.abbr));

  function startNew() {
    setEditing(false);
    setForm(EMPTY);
    setFormError(null);
  }
  function startEdit(r: Row) {
    setEditing(true);
    setForm({
      state: r.state,
      facebook: r.facebook ?? "",
      x: r.x ?? "",
      instagram: r.instagram ?? "",
    });
    setFormError(null);
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
            The Facebook, X, and Instagram links a printable signature uses,
            chosen by the card&apos;s state. States without a row fall back to the
            built-in defaults.
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
            <table className="w-full min-w-[560px] text-left text-sm">
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
