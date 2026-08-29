"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

// Self-service two-factor management on Settings (spec 0001 AC-11). Enrolment
// happens on /enroll-2fa; here the user sees their status and can start or
// disable it. Disabling requires the password.
export function TwoFactorSection({
  enrolled,
  required,
}: {
  enrolled: boolean;
  required: boolean;
}) {
  const router = useRouter();
  const [disabling, setDisabling] = useState(false);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function disable(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const { error: err } = await authClient.twoFactor.disable({ password });
    setPending(false);
    if (err) {
      setError("Couldn't disable — check your password.");
      return;
    }
    setDisabling(false);
    setPassword("");
    setMessage("Two-factor disabled.");
    router.refresh();
  }

  return (
    <section className="rounded-[--radius-panel] border border-border bg-surface p-5">
      <h2 className="text-base font-semibold text-slate-800">
        Two-factor authentication
      </h2>
      <p className="mt-1 text-sm text-muted-500">
        Add a one-time code from an authenticator app on top of your password.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
            enrolled
              ? "bg-emerald-100 text-emerald-700"
              : "bg-slate-100 text-slate-600"
          }`}
        >
          {enrolled ? "Enabled" : "Not enabled"}
        </span>

        {!enrolled && (
          <button
            type="button"
            onClick={() => router.push("/enroll-2fa")}
            className="rounded-[--radius-panel] bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800"
          >
            Set up two-factor
          </button>
        )}
        {enrolled && !required && !disabling && (
          <button
            type="button"
            onClick={() => setDisabling(true)}
            className="rounded-[--radius-panel] border border-border px-4 py-2 text-sm font-medium text-slate-700 hover:bg-canvas"
          >
            Disable
          </button>
        )}
        {required && (
          <span className="text-xs text-muted-500">
            Required by your organization — this can&apos;t be turned off.
          </span>
        )}
      </div>

      {disabling && (
        <form onSubmit={disable} className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:max-w-md">
          <input
            type="password"
            required
            autoFocus
            placeholder="Confirm your password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="flex-1 rounded-[--radius-panel] border border-border bg-canvas px-3 py-2 text-sm focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/25"
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={pending}
              className="rounded-[--radius-panel] border border-red-200 px-3 py-2 text-sm font-medium text-danger-600 hover:bg-red-50 disabled:opacity-50"
            >
              {pending ? "Disabling…" : "Disable"}
            </button>
            <button
              type="button"
              onClick={() => {
                setDisabling(false);
                setPassword("");
                setError(null);
              }}
              className="rounded-[--radius-panel] border border-border px-3 py-2 text-sm font-medium hover:bg-canvas"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {message && <p className="mt-3 text-sm text-emerald-700">{message}</p>}
      {error && <p className="mt-3 text-sm text-danger-600">{error}</p>}
    </section>
  );
}
