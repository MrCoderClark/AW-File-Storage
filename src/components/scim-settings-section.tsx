"use client";

import { useEffect, useState } from "react";

// SCIM 2.0 provisioning settings (spec 0015). Platform owner only. Generate the
// per-org bearer token the customer's IT pastes into Microsoft Entra Enterprise
// App provisioning, alongside the SCIM base URL. The token is shown ONCE at
// generation and stored only as a hash server-side — rotate to replace it (which
// invalidates the old one), or disable to turn SCIM off for this org.

interface Config {
  configured: boolean;
  active: boolean;
  lastUsedAt: string | null;
  baseUrl: string;
}

export function ScimSettingsSection() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [token, setToken] = useState(""); // shown once, in-memory only
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<"url" | "token" | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/scim-config", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setCfg((await res.json()) as Config);
    } catch {
      setError("Could not load SCIM settings.");
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function generate() {
    if (busy) return;
    setBusy(true);
    setError("");
    setToken("");
    try {
      const res = await fetch("/api/scim-config", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        token?: string;
      };
      if (!res.ok || !body.ok || !body.token) throw new Error(String(res.status));
      setToken(body.token);
      await load();
    } catch {
      setError("Could not generate the token. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (busy) return;
    setBusy(true);
    setError("");
    setToken("");
    try {
      const res = await fetch("/api/scim-config", { method: "DELETE" });
      if (!res.ok) throw new Error(String(res.status));
      await load();
    } catch {
      setError("Could not disable SCIM. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string, which: "url" | "token") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked — the value is visible to select manually */
    }
  }

  const active = cfg?.configured === true && cfg?.active === true;

  return (
    <div className="max-w-2xl">
      <h1 className="text-xl font-semibold text-brand-900">SCIM provisioning</h1>
      <p className="mt-1 text-sm text-muted-500">
        Let this organization&apos;s Microsoft Entra automatically create, update,
        and deactivate users here. Entra becomes the source of truth: when someone
        joins or leaves the company, their access is provisioned or removed for you.
        Give the base URL and token below to the customer&apos;s IT for their Entra
        Enterprise App provisioning setup.
      </p>

      <div className="mt-5 rounded-[--radius-panel] border border-border bg-surface p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-800">Status</p>
            <p className="mt-1 text-sm text-muted-500">
              {cfg === null
                ? "Loading…"
                : active
                  ? "SCIM is enabled for this organization."
                  : cfg.configured
                    ? "A token was generated but SCIM is currently disabled."
                    : "SCIM is not set up for this organization yet."}
            </p>
          </div>
          {active && (
            <span className="shrink-0 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
              Enabled
            </span>
          )}
        </div>

        {cfg && (
          <p className="mt-3 text-xs text-muted-500">
            {cfg.lastUsedAt
              ? `Last used ${new Date(cfg.lastUsedAt).toLocaleString()}.`
              : cfg.configured
                ? "Not used yet."
                : ""}
          </p>
        )}
      </div>

      {cfg && (
        <div className="mt-4 rounded-[--radius-panel] border border-border bg-surface p-5">
          <p className="text-sm font-medium text-slate-800">Entra configuration</p>

          <Field label="Tenant URL (SCIM base URL)">
            <div className="flex gap-2">
              <input
                readOnly
                value={cfg.baseUrl}
                className="w-full rounded-[--radius-panel] border border-border bg-canvas px-3 py-2 font-mono text-xs text-slate-700"
              />
              <CopyButton
                onClick={() => void copy(cfg.baseUrl, "url")}
                copied={copied === "url"}
              />
            </div>
          </Field>

          {token ? (
            <div className="mt-3">
              <Field label="Secret token — copy it now, it is shown only once">
                <div className="flex gap-2">
                  <input
                    readOnly
                    value={token}
                    className="w-full rounded-[--radius-panel] border border-amber-300 bg-amber-50 px-3 py-2 font-mono text-xs text-slate-800"
                  />
                  <CopyButton
                    onClick={() => void copy(token, "token")}
                    copied={copied === "token"}
                  />
                </div>
              </Field>
              <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
                Store this somewhere safe and paste it into Entra now. For security
                it is not stored in readable form and cannot be shown again —
                rotate to get a new one.
              </p>
            </div>
          ) : (
            cfg.configured && (
              <p className="mt-3 text-xs text-muted-500">
                The token is hidden for security. If it has been lost, rotate to
                generate a new one (the old token stops working immediately).
              </p>
            )
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void generate()}
              disabled={busy}
              className="rounded-[--radius-panel] bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy
                ? "Working…"
                : cfg.configured
                  ? "Rotate token"
                  : "Generate token"}
            </button>
            {cfg.configured && cfg.active && (
              <button
                type="button"
                onClick={() => void disable()}
                disabled={busy}
                className="rounded-[--radius-panel] border border-danger-600/40 px-4 py-2 text-sm font-medium text-danger-600 hover:bg-danger-600/[0.03] disabled:opacity-50"
              >
                Disable SCIM
              </button>
            )}
          </div>

          <p className="mt-4 text-xs text-muted-500">
            SCIM can only add people as <strong>members</strong>, update their
            profile, and suspend or remove them — within this organization. It
            never sets a role above member, never touches passwords or files, and
            never reaches another organization.
          </p>
        </div>
      )}

      {error && <p className="mt-3 text-xs text-danger-600">{error}</p>}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="mt-3 block">
      <span className="mb-1 block text-xs font-medium text-slate-700">{label}</span>
      {children}
    </label>
  );
}

function CopyButton({
  onClick,
  copied,
}: {
  onClick: () => void;
  copied: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 rounded-[--radius-panel] border border-border px-3 py-2 text-sm font-medium text-slate-700 hover:bg-canvas"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
