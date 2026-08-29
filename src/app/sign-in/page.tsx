"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Logo } from "@/components/logo";
import { authClient, signIn } from "@/lib/auth-client";

// Layout follows docs/Designs/mock-login.jpg: navy app bar, a two-column body
// (context on the left, the sign-in card on the right), and a navy footer bar.
// It collapses to a single centred column below `lg`.

const appName = process.env.NEXT_PUBLIC_APP_NAME ?? "AW File Storage";

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Second factor: after correct credentials, Better Auth asks for a code when
  // the account has 2FA enrolled (spec 0001 AC-11).
  const [needsCode, setNeedsCode] = useState(false);
  const [code, setCode] = useState("");
  const [useBackup, setUseBackup] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    // rememberMe=false gives a browser-session cookie, so the session dies with
    // the browser — the safer default on shared machines.
    const { data, error } = await signIn.email({ email, password, rememberMe });
    setPending(false);
    if (error) {
      // Generic message: never reveal whether the email exists (spec 0001 AC-1).
      setError("Email or password is incorrect.");
      return;
    }
    // The password was right; the account needs its second factor.
    if ((data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
      setNeedsCode(true);
      return;
    }
    router.push("/dashboard");
  }

  async function onVerifyCode(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const { error } = useBackup
      ? await authClient.twoFactor.verifyBackupCode({ code: code.trim() })
      : await authClient.twoFactor.verifyTotp({ code: code.trim() });
    setPending(false);
    if (error) {
      setError(
        useBackup
          ? "That backup code isn't valid."
          : "That code isn't correct — enter the current one.",
      );
      return;
    }
    router.push("/dashboard");
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between bg-brand-900 px-4 text-white sm:px-6">
        <div className="flex items-center gap-2">
          <Logo className="h-8 w-8" />
          <div className="leading-tight">
            <div className="font-semibold">{appName}</div>
            <div className="text-[11px] text-white/60">America Works</div>
          </div>
        </div>
      </header>

      <main className="flex flex-1 items-center bg-canvas px-4 py-10 sm:px-6">
        <div className="mx-auto grid w-full max-w-5xl items-center gap-10 lg:grid-cols-2 lg:gap-16">
          {/* Context column */}
          <section className="hidden lg:block">
            <h1 className="text-4xl font-semibold leading-tight text-brand-900">
              Secure file storage and published contact cards
            </h1>
            <p className="mt-5 max-w-md text-sm leading-relaxed text-muted-500">
              Upload files into private storage, then publish a contact card to a
              stable public address. Publishing is deliberate, audited, and
              reversible.
            </p>
            <ul className="mt-8 flex max-w-md flex-col gap-4">
              {[
                {
                  title: "Private by default",
                  body: "Every upload lands in a private bucket. Nothing is public until the server has validated it.",
                },
                {
                  title: "Stable public addresses",
                  body: "Published contact cards keep the same URL, so a shared link never breaks.",
                },
                {
                  title: "Every change recorded",
                  body: "Publishing, unpublishing, and deletion each write an audit entry you can review.",
                },
              ].map((f) => (
                <li key={f.title} className="flex gap-3">
                  <CheckCircleIcon className="mt-0.5 h-5 w-5 shrink-0 text-accent-500" />
                  <div>
                    <div className="text-sm font-medium text-brand-900">
                      {f.title}
                    </div>
                    <div className="mt-0.5 text-sm leading-relaxed text-muted-500">
                      {f.body}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          {/* Sign-in card */}
          <div className="mx-auto w-full max-w-md rounded-[--radius-drop] border border-border bg-surface p-6 shadow-sm sm:p-8">
            {needsCode ? (
              <>
                <h2 className="text-xl font-semibold text-brand-900">
                  Two-factor authentication
                </h2>
                <p className="mt-1.5 text-sm text-muted-500">
                  {useBackup
                    ? "Enter one of your saved backup codes."
                    : "Enter the 6-digit code from your authenticator app."}
                </p>
                <form onSubmit={onVerifyCode} className="mt-6 flex flex-col gap-4">
                  <div className="flex items-center gap-2 rounded-[--radius-panel] border border-border bg-canvas px-3 py-2.5 focus-within:border-accent-500 focus-within:ring-2 focus-within:ring-accent-500/25">
                    <LockIcon className="h-4 w-4 shrink-0 text-muted-500" />
                    <input
                      autoFocus
                      required
                      inputMode={useBackup ? "text" : "numeric"}
                      autoComplete="one-time-code"
                      placeholder={useBackup ? "Backup code" : "123456"}
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      aria-describedby={error ? "signin-error" : undefined}
                      className="w-full bg-transparent text-sm tracking-widest placeholder:text-muted-500/70 focus:outline-none"
                    />
                  </div>
                  <p
                    id="signin-error"
                    role="alert"
                    aria-live="polite"
                    className={`text-sm text-danger-600 ${error ? "" : "sr-only"}`}
                  >
                    {error}
                  </p>
                  <button
                    type="submit"
                    disabled={pending}
                    className="rounded-[--radius-panel] bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 disabled:opacity-60"
                  >
                    {pending ? "Verifying…" : "Verify"}
                  </button>
                  <div className="flex items-center justify-between text-sm">
                    <button
                      type="button"
                      onClick={() => {
                        setUseBackup((v) => !v);
                        setCode("");
                        setError(null);
                      }}
                      className="text-accent-500 hover:underline"
                    >
                      {useBackup ? "Use an authenticator code" : "Use a backup code"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setNeedsCode(false);
                        setUseBackup(false);
                        setCode("");
                        setError(null);
                      }}
                      className="text-muted-500 hover:underline"
                    >
                      Back
                    </button>
                  </div>
                </form>
              </>
            ) : (
              <>
            <h2 className="text-xl font-semibold text-brand-900">
              Sign in to your account
            </h2>
            <p className="mt-1.5 text-sm text-muted-500">
              Accounts are created by invitation. Contact your administrator if
              you need access.
            </p>

            <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
              <div>
                <label htmlFor="email" className="sr-only">
                  Work email
                </label>
                <div className="flex items-center gap-2 rounded-[--radius-panel] border border-border bg-canvas px-3 py-2.5 focus-within:border-accent-500 focus-within:ring-2 focus-within:ring-accent-500/25">
                  <MailIcon className="h-4 w-4 shrink-0 text-muted-500" />
                  <input
                    id="email"
                    name="email"
                    type="email"
                    required
                    autoComplete="username"
                    autoFocus
                    placeholder="Work email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? "signin-error" : undefined}
                    className="w-full bg-transparent text-sm placeholder:text-muted-500/70 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="password" className="sr-only">
                  Password
                </label>
                <div className="flex items-center gap-2 rounded-[--radius-panel] border border-border bg-canvas px-3 py-2.5 focus-within:border-accent-500 focus-within:ring-2 focus-within:ring-accent-500/25">
                  <LockIcon className="h-4 w-4 shrink-0 text-muted-500" />
                  <input
                    id="password"
                    name="password"
                    type="password"
                    required
                    autoComplete="current-password"
                    placeholder="Password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? "signin-error" : undefined}
                    className="w-full bg-transparent text-sm placeholder:text-muted-500/70 focus:outline-none"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between">
                <label className="flex w-fit items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="h-4 w-4 rounded-sm border-border accent-brand-600"
                  />
                  Remember me
                </label>
                <Link
                  href="/forgot-password"
                  className="text-sm text-accent-500 hover:underline"
                >
                  Forgot password?
                </Link>
              </div>

              {/* Live region so the failure is announced, not just shown. */}
              <p
                id="signin-error"
                role="alert"
                aria-live="polite"
                className={`text-sm text-danger-600 ${error ? "" : "sr-only"}`}
              >
                {error}
              </p>

              <button
                type="submit"
                disabled={pending}
                className="rounded-[--radius-panel] bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 disabled:opacity-60"
              >
                {pending ? "Signing in…" : "Sign in"}
              </button>
            </form>
              </>
            )}
          </div>
        </div>
      </main>

      <footer className="flex shrink-0 flex-col gap-1 bg-brand-900 px-4 py-3 text-[11px] text-white/60 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <span>
          &copy; {new Date().getFullYear()} America Works. All rights reserved.
        </span>
        <span>Authorised use only. Activity is logged.</span>
      </footer>
    </div>
  );
}


function CheckCircleIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.5 2.5 2.5 4.5-5" />
    </svg>
  );
}

function MailIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </svg>
  );
}

function LockIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7.5a4 4 0 0 1 8 0V10" />
    </svg>
  );
}
