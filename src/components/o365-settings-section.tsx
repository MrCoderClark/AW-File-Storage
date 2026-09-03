"use client";

import { type ReactNode, useEffect, useState } from "react";

// Office 365 sync settings (spec 0010/0013). Owner/admin only. Connect THIS org's
// own Microsoft 365 (its own Entra app), enable/disable the sync, view a status
// summary, and run a reconcile on demand. Secrets are encrypted server-side and
// never shown here.

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
        Connect your organization&apos;s own Microsoft 365 to write each published
        card&apos;s public link into the staff member&apos;s Exchange{" "}
        <code className="rounded bg-canvas px-1 py-0.5 text-xs">CustomAttribute1</code>{" "}
        via Microsoft Graph. Your credentials are yours alone.
      </p>

      <ConnectionPanel onChange={load} />

      <div className="mt-4 rounded-[--radius-panel] border border-border bg-surface p-5">
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
            Connect your organization&apos;s Microsoft 365 above before turning this
            on.
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

interface ConnStatus {
  configured: boolean;
  tenantId: string;
  clientId: string;
  method: "secret" | "certificate";
  thumbprint: string;
  lastVerifiedAt: number | null;
}

// Per-org Microsoft 365 connection (spec 0013): enter this org's own Entra app
// credentials, Save & test, or Disconnect. Secrets are write-only — never shown.
function ConnectionPanel({ onChange }: { onChange: () => void }) {
  const [status, setStatus] = useState<ConnStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [tenantId, setTenantId] = useState("");
  const [clientId, setClientId] = useState("");
  const [method, setMethod] = useState<"secret" | "certificate">("secret");
  const [secret, setSecret] = useState("");
  const [certKey, setCertKey] = useState("");
  const [thumbprint, setThumbprint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  async function loadStatus() {
    try {
      const res = await fetch("/api/settings/o365/credentials", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as ConnStatus;
      setStatus(body);
      setTenantId(body.tenantId);
      setClientId(body.clientId);
      setMethod(body.method);
      setThumbprint(body.thumbprint);
      setEditing(!body.configured);
    } catch {
      setError("Could not load the connection.");
    }
  }
  useEffect(() => {
    void loadStatus();
  }, []);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError("");
    setOk("");
    try {
      const payload =
        method === "secret"
          ? { tenantId, clientId, method, secret }
          : { tenantId, clientId, method, certPrivateKey: certKey, certThumbprint: thumbprint };
      const res = await fetch("/api/settings/o365/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !body.ok) throw new Error(body.error ?? String(res.status));
      setOk("Connected and verified.");
      setSecret(""); // never keep secret material in memory after a save
      setCertKey("");
      await loadStatus();
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not connect.");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (busy) return;
    setBusy(true);
    setError("");
    setOk("");
    try {
      const res = await fetch("/api/settings/o365/credentials", { method: "DELETE" });
      if (!res.ok) throw new Error(String(res.status));
      setTenantId("");
      setClientId("");
      setSecret("");
      setCertKey("");
      setThumbprint("");
      await loadStatus();
      onChange();
    } catch {
      setError("Could not disconnect.");
    } finally {
      setBusy(false);
    }
  }

  const connected = status?.configured === true;

  return (
    <div className="mt-5 rounded-[--radius-panel] border border-border bg-surface p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-800">Connection</p>
          <p className="mt-1 text-sm text-muted-500">
            Your organization&apos;s own Microsoft Entra app (tenant + client id and
            a secret or certificate). Used only for your tenant.
          </p>
        </div>
        {connected && (
          <span className="shrink-0 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
            Connected
          </span>
        )}
      </div>

      {connected && !editing ? (
        <div className="mt-4 space-y-1 text-xs text-muted-500">
          <p>
            Tenant <span className="font-mono text-slate-700">{status?.tenantId}</span>
          </p>
          <p>
            Client <span className="font-mono text-slate-700">{status?.clientId}</span>
          </p>
          <p>
            Auth <span className="text-slate-700">{status?.method}</span>
            {status?.lastVerifiedAt
              ? ` · verified ${new Date(status.lastVerifiedAt).toLocaleString()}`
              : ""}
          </p>
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-canvas"
            >
              Update credentials
            </button>
            <button
              type="button"
              onClick={() => void disconnect()}
              disabled={busy}
              className="rounded-md border border-danger-600/40 px-3 py-1.5 text-sm font-medium text-danger-600 hover:bg-danger-600/[0.03] disabled:opacity-50"
            >
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <Field label="Directory (tenant) ID">
            <input
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              disabled={busy}
              className="w-full rounded-[--radius-panel] border border-border px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Application (client) ID">
            <input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              disabled={busy}
              className="w-full rounded-[--radius-panel] border border-border px-3 py-2 text-sm"
            />
          </Field>
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="o365-method"
                checked={method === "secret"}
                onChange={() => setMethod("secret")}
                disabled={busy}
              />
              Client secret
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="o365-method"
                checked={method === "certificate"}
                onChange={() => setMethod("certificate")}
                disabled={busy}
              />
              Certificate
            </label>
          </div>
          {method === "secret" ? (
            <Field label="Client secret">
              <input
                type="password"
                value={secret}
                placeholder={connected ? "•••••••• (enter to replace)" : ""}
                onChange={(e) => setSecret(e.target.value)}
                disabled={busy}
                className="w-full rounded-[--radius-panel] border border-border px-3 py-2 text-sm"
              />
            </Field>
          ) : (
            <>
              <Field label="Certificate private key (PKCS8 PEM)">
                <textarea
                  value={certKey}
                  placeholder={connected ? "(enter to replace)" : "-----BEGIN PRIVATE KEY-----"}
                  onChange={(e) => setCertKey(e.target.value)}
                  disabled={busy}
                  rows={4}
                  className="w-full rounded-[--radius-panel] border border-border px-3 py-2 font-mono text-xs"
                />
              </Field>
              <Field label="Certificate thumbprint (SHA-1 hex)">
                <input
                  value={thumbprint}
                  onChange={(e) => setThumbprint(e.target.value)}
                  disabled={busy}
                  className="w-full rounded-[--radius-panel] border border-border px-3 py-2 text-sm"
                />
              </Field>
            </>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || !tenantId.trim() || !clientId.trim()}
              className="rounded-[--radius-panel] bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? "Testing…" : "Save & test"}
            </button>
            {connected && (
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setError("");
                }}
                disabled={busy}
                className="rounded-[--radius-panel] border border-border px-4 py-2 text-sm font-medium text-slate-700 hover:bg-canvas"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
      {ok && <p className="mt-3 text-xs text-emerald-700">{ok}</p>}
      {error && <p className="mt-3 text-xs text-danger-600">{error}</p>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-700">{label}</span>
      {children}
    </label>
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
