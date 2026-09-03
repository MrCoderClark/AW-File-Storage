"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { authClient, signOut } from "@/lib/auth-client";

interface OrgInfo {
  id: string;
  name: string;
  slug: string;
  storageUsedBytes: number;
  storageQuotaBytes: number;
}

interface OrgData {
  org: OrgInfo;
  role: "owner" | "admin" | "member";
  canDelete: boolean;
  canCreate: boolean;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function OrganizationSection() {
  const router = useRouter();
  const [data, setData] = useState<OrgData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    try {
      const res = await fetch("/api/organization", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setData((await res.json()) as OrgData);
    } catch {
      setError("Could not load organization settings.");
    }
  }

  if (error) {
    return (
      <div className="max-w-2xl">
        <h1 className="text-xl font-semibold text-brand-900">Organization</h1>
        <p className="mt-3 text-sm text-danger-600">{error}</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="max-w-2xl">
        <h1 className="text-xl font-semibold text-brand-900">Organization</h1>
        <p className="mt-3 text-sm text-muted-500">Loading…</p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-xl font-semibold text-brand-900">Organization</h1>
      <p className="mt-1 text-sm text-muted-500">
        Your organization’s identity and storage. Every organization’s data is
        fully isolated from every other.
      </p>

      <IdentityPanel org={data.org} role={data.role} onSaved={load} />
      <StoragePanel org={data.org} />
      {data.canCreate && <CreatePanel />}
      {data.canDelete && (
        <DeletePanel name={data.org.name} orgId={data.org.id} router={router} />
      )}
    </div>
  );
}

function IdentityPanel({
  org,
  role,
  onSaved,
}: {
  org: OrgInfo;
  role: OrgData["role"];
  onSaved: () => void;
}) {
  const canRename = role === "owner";
  const [name, setName] = useState(org.name);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  async function save() {
    const next = name.trim();
    if (!next || next === org.name) return;
    setSaving(true);
    setMsg("");
    try {
      const { error } = await authClient.organization.update({
        organizationId: org.id,
        data: { name: next },
      });
      if (error) throw new Error(error.message);
      setMsg("Saved.");
      onSaved();
    } catch {
      setMsg("Could not rename. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-5 rounded-[--radius-panel] border border-border bg-surface p-5">
      <label
        htmlFor="org-name"
        className="block text-sm font-medium text-slate-800"
      >
        Name
      </label>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          id="org-name"
          value={name}
          disabled={!canRename || saving}
          onChange={(e) => setName(e.target.value)}
          className="min-w-0 flex-1 rounded-[--radius-panel] border border-border px-3 py-2 text-sm disabled:bg-canvas disabled:text-muted-500"
        />
        {canRename && (
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || name.trim() === org.name || !name.trim()}
            className="rounded-[--radius-panel] bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        )}
      </div>
      {!canRename && (
        <p className="mt-2 text-xs text-muted-500">
          Only an owner can rename the organization.
        </p>
      )}
      {msg && <p className="mt-2 text-xs text-muted-500">{msg}</p>}
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-muted-500">
        <dt>Slug</dt>
        <dd className="font-mono text-slate-700">{org.slug}</dd>
        <dt>ID</dt>
        <dd className="font-mono text-slate-700">{org.id}</dd>
      </dl>
    </div>
  );
}

function StoragePanel({ org }: { org: OrgInfo }) {
  const pct =
    org.storageQuotaBytes > 0
      ? Math.min(100, (org.storageUsedBytes / org.storageQuotaBytes) * 100)
      : 0;
  return (
    <div className="mt-4 rounded-[--radius-panel] border border-border bg-surface p-5">
      <p className="text-sm font-medium text-slate-800">Storage</p>
      <p className="mt-1 text-sm text-muted-500">
        {formatBytes(org.storageUsedBytes)} of {formatBytes(org.storageQuotaBytes)}{" "}
        used ({pct.toFixed(pct >= 10 ? 0 : 1)}%).
      </p>
      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-200">
        <div
          className={`h-full rounded-full ${pct >= 90 ? "bg-danger-600" : "bg-brand-600"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function CreatePanel() {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/organization", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: n }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        orgId?: string;
        error?: string;
      };
      if (!res.ok || !body.ok || !body.orgId) {
        throw new Error(body.error ?? String(res.status));
      }
      // The creator is the new org's owner — switch into it and reload.
      await authClient.organization.setActive({ organizationId: body.orgId });
      window.location.assign("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create.");
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-[--radius-panel] border border-border bg-surface p-5">
      <p className="text-sm font-medium text-slate-800">Create an organization</p>
      <p className="mt-1 text-sm text-muted-500">
        As the platform owner, you can create a new, empty organization. You’ll
        become its owner and switch into it.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          value={name}
          disabled={busy}
          placeholder="Organization name"
          onChange={(e) => setName(e.target.value)}
          className="min-w-0 flex-1 rounded-[--radius-panel] border border-border px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={() => void create()}
          disabled={busy || !name.trim()}
          className="rounded-[--radius-panel] bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-danger-600">{error}</p>}
    </div>
  );
}

function DeletePanel({
  name,
  orgId,
  router,
}: {
  name: string;
  orgId: string;
  router: ReturnType<typeof useRouter>;
}) {
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function remove() {
    if (confirm !== name || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/organization", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmName: confirm }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !body.ok) throw new Error(body.error ?? String(res.status));
      // The active org (and possibly the caller's only org) is gone. Sign out for
      // a clean state; the user signs back into a remaining org if they have one.
      await signOut();
      router.push("/sign-in");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete.");
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 rounded-[--radius-panel] border border-danger-600/40 bg-danger-600/[0.03] p-5">
      <p className="text-sm font-semibold text-danger-600">Delete organization</p>
      <p className="mt-1 text-sm text-muted-500">
        Permanently deletes <span className="font-medium">{name}</span> and{" "}
        <span className="font-medium">all of its data</span> — files, cards,
        members, invitations, and history. Its published card pages go offline.
        This cannot be undone. Type the organization’s name to confirm.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          value={confirm}
          disabled={busy}
          placeholder={name}
          onChange={(e) => setConfirm(e.target.value)}
          aria-label="Type the organization name to confirm deletion"
          className="min-w-0 flex-1 rounded-[--radius-panel] border border-border px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={() => void remove()}
          disabled={busy || confirm !== name}
          className="rounded-[--radius-panel] bg-danger-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? "Deleting…" : "Delete organization"}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-danger-600">{error}</p>}
    </div>
  );
}
