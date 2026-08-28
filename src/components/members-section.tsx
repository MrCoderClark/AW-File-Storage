"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { timeAgo } from "@/lib/format";

interface MemberRow {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "member";
  status: "active" | "suspended";
  joinedAt: string;
}

export function MembersSection({ currentUserId }: { currentUserId: string }) {
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | MemberRow["role"]>("all");

  const load = useCallback(async (cursor?: string) => {
    if (cursor) setLoadingMore(true);
    else setMembers(null);
    setError(false);
    try {
      const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const res = await fetch(`/api/members${qs}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as {
        members: MemberRow[];
        nextCursor: string | null;
      };
      setMembers((prev) =>
        cursor ? [...(prev ?? []), ...body.members] : body.members,
      );
      setNextCursor(body.nextCursor);
    } catch {
      setError(true);
    } finally {
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = (members ?? []).filter((m) => {
    if (roleFilter !== "all" && m.role !== roleFilter) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q);
  });

  return (
    <section className="rounded-[--radius-panel] border border-border bg-surface">
      <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-base font-semibold text-slate-800">Members</h2>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="search"
            placeholder="Search members"
            aria-label="Search members"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="rounded-[--radius-panel] border border-border bg-canvas px-3 py-1.5 text-sm focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/25"
          />
          <select
            aria-label="Filter by role"
            value={roleFilter}
            onChange={(e) =>
              setRoleFilter(e.target.value as "all" | MemberRow["role"])
            }
            className="rounded-[--radius-panel] border border-border bg-canvas px-3 py-1.5 text-sm focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/25"
          >
            <option value="all">All roles</option>
            <option value="owner">Owner</option>
            <option value="admin">Admin</option>
            <option value="member">Member</option>
          </select>
        </div>
      </div>

      {error ? (
        <div className="p-8 text-center text-sm text-muted-500">
          <p>Couldn&apos;t load members.</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-3 rounded-[--radius-panel] border border-border px-3 py-1 text-xs font-medium hover:bg-canvas"
          >
            Retry
          </button>
        </div>
      ) : members === null ? (
        <ul className="divide-y divide-border">
          {[0, 1, 2].map((i) => (
            <li key={i} className="px-4 py-3">
              <div className="h-9 w-2/3 animate-pulse rounded bg-canvas" />
            </li>
          ))}
        </ul>
      ) : filtered.length === 0 ? (
        <p className="p-8 text-center text-sm text-muted-500">
          {members.length === 0
            ? "No members yet."
            : "No members match your search."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <caption className="sr-only">Members of your organization</caption>
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-500">
                <th scope="col" className="px-4 py-2.5 font-medium">User</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Email</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Role</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Joined</th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((m) => (
                <MemberRowView
                  key={m.id}
                  member={m}
                  isSelf={m.userId === currentUserId}
                  onChanged={() => load()}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {nextCursor && !error && (
        <div className="border-t border-border p-3 text-center">
          <button
            type="button"
            onClick={() => void load(nextCursor)}
            disabled={loadingMore}
            className="rounded-[--radius-panel] border border-border px-3 py-1.5 text-sm font-medium hover:bg-canvas disabled:opacity-50"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </section>
  );
}

function MemberRowView({
  member,
  isSelf,
  onChanged,
}: {
  member: MemberRow;
  isSelf: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmSuspend, setConfirmSuspend] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function setStatus(status: "active" | "suspended") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/members/${member.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not update the member.");
      }
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update the member.");
      setBusy(false);
    }
  }

  async function changeRole(newRole: string) {
    if (newRole === member.role) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/members/${member.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: newRole }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not change the role.");
      }
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the role.");
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/members/${member.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not remove the member.");
      }
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove the member.");
      setBusy(false);
    }
  }

  return (
    <tr className="align-top hover:bg-canvas/60">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Avatar name={member.name} />
          <span className="font-medium text-slate-800">
            {member.name}
            {isSelf && (
              <span className="ml-1 text-xs font-normal text-muted-500">
                (you)
              </span>
            )}
          </span>
        </div>
      </td>
      <td className="px-4 py-3 text-muted-500">{member.email}</td>
      <td className="px-4 py-3">
        {isSelf ? (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium capitalize text-slate-600">
            {member.role}
          </span>
        ) : (
          <select
            aria-label={`Role for ${member.name}`}
            value={member.role}
            disabled={busy}
            onChange={(e) => void changeRole(e.target.value)}
            className="rounded-[--radius-panel] border border-border bg-canvas px-2 py-1 text-xs capitalize focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/25 disabled:opacity-50"
          >
            <option value="owner">Owner</option>
            <option value="admin">Admin</option>
            <option value="member">Member</option>
          </select>
        )}
        {error && <p className="mt-1 max-w-[12rem] text-xs text-danger-600">{error}</p>}
      </td>
      <td className="px-4 py-3">
        <StatusBadge status={member.status} />
      </td>
      <td className="px-4 py-3 text-muted-500">{timeAgo(member.joinedAt)}</td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-1.5">
          <Link
            href={`/settings/users/${member.id}`}
            className="rounded-[--radius-panel] border border-border px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
          >
            View
          </Link>
          {!isSelf &&
            member.status === "suspended" &&
            !confirmRemove && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void setStatus("active")}
                className="rounded-[--radius-panel] border border-border px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-canvas disabled:opacity-50"
              >
                Reactivate
              </button>
            )}
          {!isSelf &&
            member.status === "active" &&
            !confirmRemove &&
            (confirmSuspend ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void setStatus("suspended")}
                  className="rounded-[--radius-panel] border border-amber-300 px-2.5 py-1 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                >
                  Confirm suspend
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmSuspend(false)}
                  className="rounded-[--radius-panel] border border-border px-2.5 py-1 text-xs font-medium hover:bg-canvas"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmSuspend(true)}
                className="rounded-[--radius-panel] border border-amber-300 px-2.5 py-1 text-xs font-medium text-amber-700 hover:bg-amber-50"
              >
                Suspend
              </button>
            ))}
          {!isSelf &&
            !confirmSuspend &&
            (confirmRemove ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void remove()}
                  className="rounded-[--radius-panel] border border-red-200 px-2.5 py-1 text-xs font-medium text-danger-600 hover:bg-red-50 disabled:opacity-50"
                >
                  Confirm
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmRemove(false)}
                  className="rounded-[--radius-panel] border border-border px-2.5 py-1 text-xs font-medium hover:bg-canvas"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmRemove(true)}
                className="rounded-[--radius-panel] border border-red-200 px-2.5 py-1 text-xs font-medium text-danger-600 hover:bg-red-50"
              >
                Remove
              </button>
            ))}
        </div>
      </td>
    </tr>
  );
}

function StatusBadge({ status }: { status: MemberRow["status"] }) {
  return status === "active" ? (
    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
      Active
    </span>
  ) : (
    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">
      Suspended
    </span>
  );
}

function Avatar({ name }: { name: string }) {
  const initials = name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-600/10 text-xs font-semibold text-brand-600">
      {initials || "•"}
    </span>
  );
}
