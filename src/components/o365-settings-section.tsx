"use client";

import { useEffect, useState } from "react";

// Office 365 sync settings (spec 0010). Owner/admin only. Enable/disable the
// sync, see whether the Graph credentials are configured, view a status summary,
// and run a reconcile on demand. Credentials are Worker secrets, never shown here.

interface Summary {
  synced: number;
  no_match: number;
  ambiguous: number;
  error: number;
}
interface State {
  enabled: boolean;
  configured: boolean;
  summary: Summary;
}

export function O365SettingsSection() {
  const [state, setState] = useState<State | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  async function load() {
    try {
      const res = await fetch("/api/settings/o365", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setState((await res.json()) as State);
    } catch {
      setError("Could not load Office 365 settings.");
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function toggle(next: boolean) {
    if (!state) return;
    setSaving(true);
    setError("");
    setMsg("");
    const prev = state.enabled;
    setState({ ...state, enabled: next });
    try {
      const res = await fetch("/api/settings/o365", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setState({ ...state, enabled: prev });
      setError("Could not save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function syncNow() {
    setSyncing(true);
    setError("");
    setMsg("");
    try {
      const res = await fetch("/api/settings/o365/sync", { method: "POST" });
      const body = (await res.json()) as { processed?: number; enabled?: boolean };
      if (!res.ok) throw new Error(String(res.status));
      setMsg(
        body.enabled === false
          ? "Sync is off (enable it and set the credentials first)."
          : `Synced ${body.processed ?? 0} published cards.`,
      );
      await load(); // refresh the summary
    } catch {
      setError("Sync failed. Try again.");
    } finally {
      setSyncing(false);
    }
  }

  const s = state?.summary;

  return (
    <div className="max-w-2xl">
      <h1 className="text-xl font-semibold text-brand-900">Office 365</h1>
      <p className="mt-1 text-sm text-muted-500">
        Write each published card&apos;s public link into the staff member&apos;s
        Exchange <code className="rounded bg-canvas px-1 py-0.5 text-xs">CustomAttribute1</code>{" "}
        via Microsoft Graph.
      </p>

      <div className="mt-5 rounded-[--radius-panel] border border-border bg-surface p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-800">
              Sync card links to Office 365
            </p>
            <p className="mt-1 text-sm text-muted-500">
              When on, publishing or editing a card writes its{" "}
              <code className="rounded bg-canvas px-1 py-0.5 text-xs">.vcf</code>{" "}
              URL into the matched mailbox&apos;s CustomAttribute1, and clears it on
              unpublish or delete. A nightly job keeps everything current.
            </p>
          </div>
          <Switch
            checked={state?.enabled === true}
            disabled={state === null || saving || state?.configured === false}
            onChange={toggle}
            label="Sync card links to Office 365"
          />
        </div>

        {state && !state.configured && (
          <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
            The Microsoft Graph credentials are not set. Add the{" "}
            <code>GRAPH_TENANT_ID</code>, <code>GRAPH_CLIENT_ID</code>, and{" "}
            <code>GRAPH_CLIENT_SECRET</code> Worker secrets, then this toggle will
            work.
          </p>
        )}
        {state === null && !error && (
          <p className="mt-3 text-xs text-muted-500">Loading…</p>
        )}
        {error && <p className="mt-3 text-xs text-danger-600">{error}</p>}
      </div>

      {s && (
        <div className="mt-4 rounded-[--radius-panel] border border-border bg-surface p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-800">Status</h2>
            <button
              type="button"
              onClick={() => void syncNow()}
              disabled={syncing || state?.enabled !== true}
              className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-canvas disabled:opacity-50"
            >
              {syncing ? "Syncing…" : "Sync all now"}
            </button>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Synced" value={s.synced} tone="ok" />
            <Stat label="No match" value={s.no_match} tone="warn" />
            <Stat label="Ambiguous" value={s.ambiguous} tone="warn" />
            <Stat label="Errors" value={s.error} tone="bad" />
          </div>
          {msg && <p className="mt-3 text-xs text-muted-500">{msg}</p>}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "ok" | "warn" | "bad";
}) {
  const color =
    tone === "ok"
      ? "text-emerald-700"
      : tone === "warn"
        ? "text-amber-700"
        : "text-danger-600";
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <p className={`text-lg font-semibold tabular-nums ${color}`}>{value}</p>
      <p className="text-xs text-muted-500">{label}</p>
    </div>
  );
}

function Switch({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
        checked ? "bg-brand-600" : "bg-slate-300"
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
