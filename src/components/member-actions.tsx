"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Admin actions on a member's account (spec 0005 AC-11, plus admin password
// reset added by request). Each destructive action confirms, naming the person.
export function MemberActions({
  memberId,
  memberName,
}: {
  memberId: string;
  memberName: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resetUrl, setResetUrl] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");

  async function call(
    kind: string,
    path: string,
    method: "DELETE" | "POST",
    opts: {
      confirm?: string;
      body?: unknown;
      onOk: (body: Record<string, unknown>) => string;
    },
  ) {
    if (opts.confirm && !window.confirm(opts.confirm)) return;
    setBusy(kind);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(path, {
        method,
        headers: opts.body ? { "Content-Type": "application/json" } : undefined,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      const body = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!res.ok || !body.ok) {
        throw new Error((body.error as string) ?? "Action failed.");
      }
      setMessage(opts.onOk(body));
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mt-4 rounded-[--radius-panel] border border-border bg-surface p-5">
      <h2 className="text-sm font-semibold text-slate-800">Account actions</h2>
      <p className="mt-1 text-xs text-muted-500">
        These affect {memberName}&apos;s access.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() =>
            call("sessions", `/api/members/${memberId}/sessions`, "DELETE", {
              confirm: `Revoke all active sessions for ${memberName}? They will be signed out everywhere.`,
              onOk: (b) => `Revoked ${Number(b.revoked ?? 0)} session(s).`,
            })
          }
          className="rounded-[--radius-panel] border border-border px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-canvas disabled:opacity-50"
        >
          {busy === "sessions" ? "Revoking…" : "Revoke sessions"}
        </button>

        <button
          type="button"
          disabled={busy !== null}
          onClick={() =>
            call("twofactor", `/api/members/${memberId}/two-factor`, "DELETE", {
              confirm: `Reset two-factor for ${memberName}? They must enrol again on next sign-in.`,
              onOk: () => "Two-factor reset. They must enrol again.",
            })
          }
          className="rounded-[--radius-panel] border border-border px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-canvas disabled:opacity-50"
        >
          {busy === "twofactor" ? "Resetting…" : "Reset two-factor"}
        </button>

        <button
          type="button"
          disabled={busy !== null}
          onClick={() =>
            call("resetlink", `/api/members/${memberId}/reset-link`, "POST", {
              confirm: `Send a password-reset link to ${memberName}?`,
              onOk: (b) => {
                setResetUrl((b.url as string) ?? null);
                return "Reset link generated (and emailed if delivery is configured).";
              },
            })
          }
          className="rounded-[--radius-panel] border border-border px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-canvas disabled:opacity-50"
        >
          {busy === "resetlink" ? "Sending…" : "Send reset link"}
        </button>
      </div>

      {resetUrl && (
        <div className="mt-3 rounded-[--radius-panel] border border-border bg-canvas p-3">
          <p className="text-xs font-medium text-slate-700">
            Share this link with {memberName} (single use):
          </p>
          <div className="mt-1 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate text-xs text-accent-500">
              {resetUrl}
            </code>
            <button
              type="button"
              onClick={() => void navigator.clipboard.writeText(resetUrl)}
              className="shrink-0 rounded border border-border px-2 py-0.5 text-[11px] font-medium hover:bg-surface"
            >
              Copy
            </button>
          </div>
        </div>
      )}

      {/* Admin-set a new password directly */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void call("password", `/api/members/${memberId}/password`, "POST", {
            confirm: `Set a new password for ${memberName}? Their current sessions will be revoked.`,
            body: { password: newPassword },
            onOk: () => {
              setNewPassword("");
              return "Password updated and sessions revoked.";
            },
          });
        }}
        className="mt-4 flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-end"
      >
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs font-medium text-slate-700">
            Set a new password
          </span>
          <input
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="At least 12 characters"
            className="rounded-[--radius-panel] border border-border bg-canvas px-3 py-2 text-sm focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/25"
          />
        </label>
        <button
          type="submit"
          disabled={busy !== null || newPassword.length < 12}
          className="rounded-[--radius-panel] bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-50"
        >
          {busy === "password" ? "Setting…" : "Set password"}
        </button>
      </form>

      {message && <p className="mt-3 text-sm text-emerald-700">{message}</p>}
      {error && <p className="mt-3 text-sm text-danger-600">{error}</p>}
    </section>
  );
}
