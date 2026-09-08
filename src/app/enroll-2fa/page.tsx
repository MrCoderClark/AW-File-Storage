"use client";

import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { AuthShell } from "@/components/auth-shell";
import { authClient } from "@/lib/auth-client";

// Two-factor enrolment (spec 0001 AC-11). Confirm password → scan a QR (or type
// the key) → verify a code. Reachable from Settings; also the redirect target
// if 2FA enforcement is turned on later.
export default function EnrollTwoFactorPage() {
  const router = useRouter();
  const [step, setStep] = useState<"password" | "verify">("password");
  const [password, setPassword] = useState("");
  const [totpUri, setTotpUri] = useState("");
  const [secret, setSecret] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onEnable(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const { data, error: err } = await authClient.twoFactor.enable({ password });
    setPending(false);
    if (err || !data) {
      setError("Could not start enrolment. Check your password.");
      return;
    }
    // Better Auth 1.7 returns a discriminated union keyed by `method`; the TOTP
    // enrolment (what this page does) carries totpURI + backupCodes (spec 0023).
    if (data.method !== "totp") {
      setError("Could not start enrolment. Check your password.");
      return;
    }
    const uri = data.totpURI;
    setTotpUri(uri);
    setSecret(new URLSearchParams(uri.split("?")[1] ?? "").get("secret") ?? "");
    setBackupCodes(data.backupCodes);
    setStep("verify");
  }

  async function onVerify(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const { error: err } = await authClient.twoFactor.verifyTotp({
      code: code.trim(),
    });
    setPending(false);
    if (err) {
      setError("That code was not correct. Enter the current one.");
      return;
    }
    router.push("/settings");
  }

  return (
    <AuthShell
      title="Set up two-factor authentication"
      subtitle="Add a one-time code from an authenticator app on top of your password."
    >
      {step === "password" ? (
        <form onSubmit={onEnable} className="mt-6 flex flex-col gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-slate-700">
              Confirm your password
            </span>
            <input
              type="password"
              required
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded-[--radius-panel] border border-border bg-canvas px-3 py-2.5 text-sm focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/25"
            />
          </label>
          {error && <p className="text-sm text-danger-600">{error}</p>}
          <button
            type="submit"
            disabled={pending}
            className="rounded-[--radius-panel] bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-60"
          >
            {pending ? "Starting…" : "Continue"}
          </button>
        </form>
      ) : (
        <div className="mt-6 flex flex-col gap-5">
          <div>
            <p className="text-sm text-muted-500">
              Scan this with your authenticator app:
            </p>
            <div className="mt-2 flex justify-center">
              <QrImage value={totpUri} />
            </div>
            <p className="mt-2 text-center text-xs text-muted-500">
              Can&apos;t scan? Enter this key manually:
            </p>
            <code className="mt-1 block break-all text-center text-xs text-slate-700">
              {secret}
            </code>
          </div>

          {backupCodes.length > 0 && (
            <div className="rounded-[--radius-panel] border border-border bg-canvas p-3">
              <p className="text-sm font-medium text-slate-700">Backup codes</p>
              <p className="text-xs text-muted-500">
                Save these somewhere safe — each works once if you lose your
                device.
              </p>
              <ul className="mt-2 grid grid-cols-2 gap-1 text-sm">
                {backupCodes.map((c) => (
                  <li key={c}>
                    <code>{c}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <form onSubmit={onVerify} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium text-slate-700">
                Enter the 6-digit code to finish
              </span>
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="rounded-[--radius-panel] border border-border bg-canvas px-3 py-2.5 text-sm tracking-widest focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/25"
              />
            </label>
            {error && <p className="text-sm text-danger-600">{error}</p>}
            <button
              type="submit"
              disabled={pending}
              className="rounded-[--radius-panel] bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-60"
            >
              {pending ? "Verifying…" : "Enable two-factor"}
            </button>
          </form>
        </div>
      )}
    </AuthShell>
  );
}

function QrImage({ value }: { value: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!value) return;
    let active = true;
    QRCode.toDataURL(value, { width: 180, margin: 1 })
      .then((url) => {
        if (active) setSrc(url);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [value]);

  if (!src) {
    return <div className="h-[180px] w-[180px] animate-pulse rounded bg-canvas" />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt="QR code to add this account to your authenticator app"
      width={180}
      height={180}
      className="rounded border border-border"
    />
  );
}
