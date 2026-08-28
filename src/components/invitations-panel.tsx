"use client";

import { useCallback, useEffect, useState } from "react";

interface Invitation {
  id: string;
  email: string;
  role: "admin" | "member";
  expiresAt: string;
  createdAt: string;
}

export function InvitationsPanel() {
  const [invitations, setInvitations] = useState<Invitation[] | null>(null);
  const [error, setError] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    try {
      const res = await fetch("/api/invitations", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { invitations: Invitation[] };
      setInvitations(body.invitations);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="mt-6 rounded-[--radius-panel] border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border p-4">
        <h2 className="text-base font-semibold text-slate-800">
          Pending invitations
        </h2>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="rounded-[--radius-panel] bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
        >
          {showForm ? "Cancel" : "Invite user"}
        </button>
      </div>

      {showForm && (
        <InviteForm reload={load} close={() => setShowForm(false)} />
      )}

      {error ? (
        <div className="p-8 text-center text-sm text-muted-500">
          <p>Couldn&apos;t load invitations.</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-3 rounded-[--radius-panel] border border-border px-3 py-1 text-xs font-medium hover:bg-canvas"
          >
            Retry
          </button>
        </div>
      ) : invitations === null ? (
        <div className="space-y-2 p-4">
          {[0, 1].map((i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-canvas" />
          ))}
        </div>
      ) : invitations.length === 0 ? (
        <p className="p-8 text-center text-sm text-muted-500">
          No pending invitations.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {invitations.map((inv) => (
            <InvitationRow key={inv.id} invitation={inv} onChange={load} />
          ))}
        </ul>
      )}
    </section>
  );
}

function InviteForm({
  reload,
  close,
}: {
  reload: () => void | Promise<void>;
  close: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devUrl, setDevUrl] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    setDevUrl(null);
    try {
      const res = await fetch("/api/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        url?: string;
      };
      if (!res.ok || !body.ok) {
        throw new Error(body.error ?? "Could not send the invitation.");
      }
      await reload(); // refresh the pending list either way
      if (body.url) {
        // Dev only: no email is sent, so surface the link to test with and keep
        // the form open.
        setDevUrl(body.url);
        setEmail("");
        return;
      }
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 border-b border-border bg-canvas/50 p-4 sm:flex-row sm:items-end"
    >
      <label className="flex flex-1 flex-col gap-1">
        <span className="text-xs font-medium text-slate-700">Email</span>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="person@example.com"
          className="rounded-[--radius-panel] border border-border bg-surface px-3 py-2 text-sm focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/25"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-slate-700">Role</span>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as "member" | "admin")}
          className="rounded-[--radius-panel] border border-border bg-surface px-3 py-2 text-sm focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/25"
        >
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-[--radius-panel] bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-60"
      >
        {pending ? "Sending…" : "Send invite"}
      </button>
      {error && (
        <p className="text-sm text-danger-600 sm:w-full" role="alert">
          {error}
        </p>
      )}
      {devUrl && (
        <p className="text-xs text-muted-500 sm:w-full">
          Dev link (no email sent):{" "}
          <a href={devUrl} className="break-all text-accent-500 underline">
            {devUrl}
          </a>
        </p>
      )}
    </form>
  );
}

function InvitationRow({
  invitation,
  onChange,
}: {
  invitation: Invitation;
  onChange: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(method: "DELETE" | "POST", path: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, { method });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Action failed.");
      }
      await onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-slate-800">
          {invitation.email}
        </p>
        <p className="text-xs text-muted-500">
          <span className="capitalize">{invitation.role}</span> · expires{" "}
          {new Date(invitation.expiresAt).toLocaleDateString()}
        </p>
        {error && <p className="mt-1 text-xs text-danger-600">{error}</p>}
      </div>
      <div className="flex shrink-0 gap-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            act("POST", `/api/invitations/${invitation.id}/resend`)
          }
          className="rounded-[--radius-panel] border border-border px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-canvas disabled:opacity-50"
        >
          Resend
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => act("DELETE", `/api/invitations/${invitation.id}`)}
          className="rounded-[--radius-panel] border border-red-200 px-2.5 py-1 text-xs font-medium text-danger-600 hover:bg-red-50 disabled:opacity-50"
        >
          Revoke
        </button>
      </div>
    </li>
  );
}
