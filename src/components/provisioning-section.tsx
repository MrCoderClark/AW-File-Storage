"use client";

import { useEffect, useState } from "react";

interface Org {
  id: string;
  name: string;
}
type Role = "admin" | "member";
type Assignments = Record<string, Role>; // orgId -> role

function toList(a: Assignments) {
  return Object.entries(a).map(([orgId, role]) => ({ orgId, role }));
}

export function ProvisioningSection() {
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/provisioning", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { orgs: Org[] };
        setOrgs(body.orgs ?? []);
      } catch {
        setError("Could not load organizations.");
      }
    })();
  }, []);

  return (
    <div className="max-w-2xl">
      <h1 className="text-xl font-semibold text-brand-900">Provisioning</h1>
      <p className="mt-1 text-sm text-muted-500">
        Add people to organizations. New accounts get an invitation to set their own
        password; the organization is suggested from the email domain (your verified
        Microsoft domains), and you can change or add organizations before sending.
      </p>
      {error && <p className="mt-3 text-sm text-danger-600">{error}</p>}

      <AddUser orgs={orgs} />
      <BulkProvision orgs={orgs} />
    </div>
  );
}

function OrgPicker({
  orgs,
  value,
  onChange,
  suggestedId,
  disabledIds,
}: {
  orgs: Org[];
  value: Assignments;
  onChange: (next: Assignments) => void;
  suggestedId?: string | null;
  disabledIds?: Set<string>;
}) {
  function toggle(orgId: string) {
    if (disabledIds?.has(orgId)) return;
    const next = { ...value };
    if (next[orgId]) delete next[orgId];
    else next[orgId] = "member";
    onChange(next);
  }
  function setRole(orgId: string, role: Role) {
    onChange({ ...value, [orgId]: role });
  }
  return (
    <div className="mt-2 max-h-56 overflow-y-auto rounded-[--radius-panel] border border-border">
      {orgs.length === 0 && (
        <p className="px-3 py-2 text-xs text-muted-500">No organizations yet.</p>
      )}
      {orgs.map((o) => {
        const disabled = disabledIds?.has(o.id) ?? false;
        const checked = Boolean(value[o.id]);
        return (
          <div
            key={o.id}
            className={`flex items-center justify-between gap-3 border-b border-border px-3 py-2 last:border-b-0 ${
              disabled ? "opacity-50" : ""
            }`}
          >
            <label
              className={`flex min-w-0 items-center gap-2 text-sm ${
                disabled ? "cursor-not-allowed" : ""
              }`}
            >
              <input
                type="checkbox"
                checked={checked && !disabled}
                disabled={disabled}
                onChange={() => toggle(o.id)}
              />
              <span className="truncate">{o.name}</span>
              {disabled ? (
                <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">
                  already a member
                </span>
              ) : (
                suggestedId === o.id && (
                  <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                    from domain
                  </span>
                )
              )}
            </label>
            {checked && !disabled && (
              <select
                value={value[o.id]}
                onChange={(e) => setRole(o.id, e.target.value as Role)}
                className="rounded border border-border px-2 py-1 text-xs"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            )}
          </div>
        );
      })}
    </div>
  );
}

function AddUser({ orgs }: { orgs: Org[] }) {
  const [email, setEmail] = useState("");
  const [assignments, setAssignments] = useState<Assignments>({});
  const [suggestedId, setSuggestedId] = useState<string | null>(null);
  const [existingOrgIds, setExistingOrgIds] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"invite" | "existing">("invite");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  async function onEmailBlur() {
    const e = email.trim().toLowerCase();
    setSuggestedId(null);
    setExistingOrgIds(new Set());
    if (!e.includes("@")) return;
    try {
      const res = await fetch(`/api/provisioning/suggest?email=${encodeURIComponent(e)}`);
      const body = (await res.json()) as {
        match: { orgId: string } | null;
        existingOrgIds?: string[];
        accountExists?: boolean;
      };
      const existing = new Set(body.existingOrgIds ?? []);
      setExistingOrgIds(existing);
      // If they already have an account, default to adding directly.
      setMode(body.accountExists ? "existing" : "invite");
      // Drop any picked org they already belong to.
      setAssignments((a) => {
        const next: Assignments = {};
        for (const [orgId, role] of Object.entries(a)) {
          if (!existing.has(orgId)) next[orgId] = role;
        }
        return next;
      });
      // Pre-select the domain-matched org, unless they're already in it.
      if (body.match && !existing.has(body.match.orgId)) {
        setSuggestedId(body.match.orgId);
        setAssignments((a) =>
          a[body.match!.orgId] ? a : { ...a, [body.match!.orgId]: "member" },
        );
      }
    } catch {
      /* lookup is best-effort */
    }
  }

  async function submit() {
    const list = toList(assignments);
    if (!email.trim() || list.length === 0 || busy) return;
    setBusy(true);
    setMsg("");
    setError("");
    try {
      const url = mode === "invite" ? "/api/provisioning" : "/api/provisioning/assign";
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), assignments: list }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        added?: number;
      };
      if (!res.ok || !body.ok) throw new Error(body.error ?? String(res.status));
      setMsg(
        mode === "invite"
          ? `Invitation sent to ${email.trim()}.`
          : `Added to ${body.added ?? 0} organization(s).`,
      );
      setEmail("");
      setAssignments({});
      setSuggestedId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the user.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-5 rounded-[--radius-panel] border border-border bg-surface p-5">
      <p className="text-sm font-medium text-slate-800">Add a user</p>
      <label className="mt-3 block">
        <span className="mb-1 block text-xs font-medium text-slate-700">Email</span>
        <input
          value={email}
          disabled={busy}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={onEmailBlur}
          placeholder="name@company.com"
          className="w-full rounded-[--radius-panel] border border-border px-3 py-2 text-sm"
        />
      </label>

      <p className="mt-3 text-xs font-medium text-slate-700">Organizations & roles</p>
      <OrgPicker
        orgs={orgs}
        value={assignments}
        onChange={setAssignments}
        suggestedId={suggestedId}
        disabledIds={existingOrgIds}
      />

      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name="add-mode"
            checked={mode === "invite"}
            onChange={() => setMode("invite")}
          />
          New account (send invitation)
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name="add-mode"
            checked={mode === "existing"}
            onChange={() => setMode("existing")}
          />
          Existing account (add directly)
        </label>
      </div>

      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy || !email.trim() || Object.keys(assignments).length === 0}
        className="mt-4 rounded-[--radius-panel] bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? "Working…" : mode === "invite" ? "Send invitation" : "Add to organizations"}
      </button>
      {msg && <p className="mt-2 text-xs text-emerald-700">{msg}</p>}
      {error && <p className="mt-2 text-xs text-danger-600">{error}</p>}
    </div>
  );
}

interface BulkRow {
  email: string;
  orgId: string | null;
  orgName: string | null;
}

function BulkProvision({ orgs }: { orgs: Org[] }) {
  const [text, setText] = useState("");
  const [rows, setRows] = useState<BulkRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const nameOf = (id: string) => orgs.find((o) => o.id === id)?.name ?? id;

  async function preview() {
    const emails = [
      ...new Set(
        text
          .split(/[\s,;]+/)
          .map((e) => e.trim().toLowerCase())
          .filter((e) => e.includes("@")),
      ),
    ];
    setBusy(true);
    setMsg("");
    try {
      const out: BulkRow[] = [];
      for (const email of emails) {
        const res = await fetch(`/api/provisioning/suggest?email=${encodeURIComponent(email)}`);
        const body = (await res.json().catch(() => ({}))) as {
          match: { orgId: string; orgName: string } | null;
        };
        out.push({
          email,
          orgId: body.match?.orgId ?? null,
          orgName: body.match?.orgName ?? null,
        });
      }
      setRows(out);
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!rows) return;
    const ready = rows.filter((r) => r.orgId);
    setBusy(true);
    setMsg("");
    let sent = 0;
    for (const r of ready) {
      const res = await fetch("/api/provisioning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: r.email,
          assignments: [{ orgId: r.orgId, role: "member" }],
        }),
      });
      if (res.ok) sent++;
    }
    setBusy(false);
    setMsg(`Sent ${sent} invitation(s).`);
    setRows(null);
    setText("");
  }

  const matched = rows?.filter((r) => r.orgId).length ?? 0;
  const unmatched = rows?.filter((r) => !r.orgId).length ?? 0;

  return (
    <div className="mt-4 rounded-[--radius-panel] border border-border bg-surface p-5">
      <p className="text-sm font-medium text-slate-800">Bulk invite</p>
      <p className="mt-1 text-sm text-muted-500">
        Paste email addresses (one per line, or comma-separated). Each is matched to
        an organization by its domain; unmatched addresses are skipped.
      </p>
      <textarea
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder="alice@company.com&#10;bob@company.com"
        className="mt-3 w-full rounded-[--radius-panel] border border-border px-3 py-2 font-mono text-xs"
      />
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => void preview()}
          disabled={busy || !text.trim()}
          className="rounded-[--radius-panel] border border-border px-4 py-2 text-sm font-medium text-slate-700 hover:bg-canvas disabled:opacity-50"
        >
          {busy && !rows ? "Checking…" : "Preview"}
        </button>
        {rows && matched > 0 && (
          <button
            type="button"
            onClick={() => void send()}
            disabled={busy}
            className="rounded-[--radius-panel] bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? "Sending…" : `Send ${matched} invitation(s)`}
          </button>
        )}
      </div>
      {rows && (
        <div className="mt-3 space-y-1 text-xs">
          {rows.map((r) => (
            <div key={r.email} className="flex justify-between gap-3">
              <span className="truncate text-slate-700">{r.email}</span>
              <span className={r.orgId ? "text-emerald-700" : "text-danger-600"}>
                {r.orgId ? nameOf(r.orgId) : "no domain match"}
              </span>
            </div>
          ))}
          {unmatched > 0 && (
            <p className="pt-1 text-muted-500">{unmatched} will be skipped.</p>
          )}
        </div>
      )}
      {msg && <p className="mt-2 text-xs text-emerald-700">{msg}</p>}
    </div>
  );
}
