"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

// Complete a password reset with the token from the emailed link (spec 0005
// AC-13). No token → the link was malformed; show a plain message.
export function ResetPasswordForm({ token }: { token?: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!token) {
    return (
      <div className="mt-4">
        <p className="text-sm text-muted-500">
          This reset link is invalid or incomplete. Request a new one.
        </p>
        <Link
          href="/forgot-password"
          className="mt-6 inline-block rounded-[--radius-panel] bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-800"
        >
          Request a new link
        </Link>
      </div>
    );
  }

  if (done) {
    return (
      <div className="mt-4">
        <p className="text-sm text-slate-700">
          Your password has been reset. You can sign in with it now.
        </p>
        <Link
          href="/sign-in"
          className="mt-6 inline-block rounded-[--radius-panel] bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-800"
        >
          Go to sign in
        </Link>
      </div>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const { error: err } = await authClient.resetPassword({
        newPassword: password,
        token,
      });
      if (err) {
        throw new Error(
          err.message ?? "This link is invalid or has expired.",
        );
      }
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reset your password.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-6 flex flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-slate-700">New password</span>
        <input
          type="password"
          required
          minLength={12}
          autoFocus
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-[--radius-panel] border border-border bg-canvas px-3 py-2.5 text-sm focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/25"
        />
        <span className="text-xs text-muted-500">
          At least 12 characters. Checked against known breached passwords.
        </span>
      </label>
      {error && (
        <p role="alert" className="text-sm text-danger-600">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-[--radius-panel] bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-60"
      >
        {pending ? "Resetting…" : "Reset password"}
      </button>
    </form>
  );
}
