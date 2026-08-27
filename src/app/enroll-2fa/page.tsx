"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

// Two-factor enrolment (spec 0001 AC-11). Owner/admin are redirected here by
// requireOrgRole until they enrol. Plain UI for now (no QR image yet — the setup
// key can be typed into any authenticator app); Phase 4 adds the QR + polish.
export default function EnrollTwoFactorPage() {
  const router = useRouter();
  const [step, setStep] = useState<"password" | "verify">("password");
  const [password, setPassword] = useState("");
  const [secret, setSecret] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onEnable(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const { data, error } = await authClient.twoFactor.enable({ password });
    setPending(false);
    if (error || !data) {
      setError("Could not start enrolment. Check your password.");
      return;
    }
    const uri = data.totpURI ?? "";
    setSecret(new URLSearchParams(uri.split("?")[1] ?? "").get("secret") ?? uri);
    setBackupCodes(data.backupCodes ?? []);
    setStep("verify");
  }

  async function onVerify(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const { error } = await authClient.twoFactor.verifyTotp({ code });
    setPending(false);
    if (error) {
      setError("That code was not correct. Try the current one.");
      return;
    }
    router.push("/dashboard");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6">
      <h1 className="text-2xl font-semibold text-brand-900">
        Set up two-factor authentication
      </h1>
      <p className="text-sm text-muted-500">
        Admins must protect their account with an authenticator app before
        reaching admin tools.
      </p>

      {step === "password" ? (
        <form onSubmit={onEnable} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-500">Confirm your password</span>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded-[--radius-panel] border border-border px-3 py-2"
            />
          </label>
          {error && <p className="text-sm text-danger-600">{error}</p>}
          <button
            type="submit"
            disabled={pending}
            className="rounded-[--radius-panel] bg-brand-600 px-4 py-2 font-medium text-white disabled:opacity-60"
          >
            {pending ? "Starting…" : "Continue"}
          </button>
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="rounded-[--radius-panel] border border-border bg-surface p-4">
            <p className="text-sm text-muted-500">
              Add this setup key to your authenticator app:
            </p>
            <code className="mt-1 block break-all text-sm">{secret}</code>
          </div>
          {backupCodes.length > 0 && (
            <div className="rounded-[--radius-panel] border border-border bg-surface p-4">
              <p className="text-sm text-muted-500">
                Save these backup codes (each works once):
              </p>
              <ul className="mt-1 grid grid-cols-2 gap-1 text-sm">
                {backupCodes.map((c) => (
                  <li key={c}>
                    <code>{c}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <form onSubmit={onVerify} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-500">
                Enter the 6-digit code to finish
              </span>
              <input
                inputMode="numeric"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="rounded-[--radius-panel] border border-border px-3 py-2"
              />
            </label>
            {error && <p className="text-sm text-danger-600">{error}</p>}
            <button
              type="submit"
              disabled={pending}
              className="rounded-[--radius-panel] bg-brand-600 px-4 py-2 font-medium text-white disabled:opacity-60"
            >
              {pending ? "Verifying…" : "Enable two-factor"}
            </button>
          </form>
        </div>
      )}
    </main>
  );
}
