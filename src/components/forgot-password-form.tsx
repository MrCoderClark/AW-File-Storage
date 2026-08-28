"use client";

import Link from "next/link";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

// Request a password reset (spec 0005 AC-13). The response is identical whether
// or not the email exists — never reveal account existence.
export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    // Ignore the result: success is shown regardless (enumeration protection).
    await authClient
      .requestPasswordReset({ email, redirectTo: "/reset-password" })
      .catch(() => {});
    setPending(false);
    setSent(true);
  }

  if (sent) {
    return (
      <div className="mt-6">
        <p className="text-sm text-slate-700">
          If an account exists for <span className="font-medium">{email}</span>,
          we&apos;ve sent a link to reset its password. The link expires shortly.
        </p>
        <Link
          href="/sign-in"
          className="mt-6 inline-block rounded-[--radius-panel] bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-800"
        >
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-6 flex flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-slate-700">Work email</span>
        <input
          type="email"
          required
          autoFocus
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-[--radius-panel] border border-border bg-canvas px-3 py-2.5 text-sm focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/25"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-[--radius-panel] bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-60"
      >
        {pending ? "Sending…" : "Send reset link"}
      </button>
      <Link href="/sign-in" className="text-center text-sm text-accent-500 hover:underline">
        Back to sign in
      </Link>
    </form>
  );
}
