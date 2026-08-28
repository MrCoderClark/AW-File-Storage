"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { signIn } from "@/lib/auth-client";

// The invitation acceptance form (spec 0005 AC-1). Creates the account via the
// accept-invitation route (the invitation id is the capability), then signs the
// new account in from the browser so the session cookie is set correctly, and
// lands them in the app.
export function AcceptForm({
  invitationId,
  email,
  role,
}: {
  invitationId: string;
  email: string;
  role: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/invitations/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invitationId, name, password }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !body.ok) {
        throw new Error(body.error ?? "This invitation could not be accepted.");
      }
      // Account exists and is verified — sign in from the browser to set the
      // session cookie, then enter the app.
      const { error: signInError } = await signIn.email({ email, password });
      if (signInError) {
        // The account was created; send them to sign in manually.
        router.push("/sign-in");
        return;
      }
      router.push("/upload-center");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
      <div>
        <span className="text-xs font-medium uppercase tracking-wide text-muted-500">
          Email
        </span>
        <p className="mt-1 rounded-[--radius-panel] border border-border bg-canvas px-3 py-2.5 text-sm text-slate-700">
          {email}
        </p>
        <p className="mt-1 text-xs text-muted-500">
          You&apos;re joining as{" "}
          <span className="font-medium capitalize text-slate-700">{role}</span>.
        </p>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-slate-700">Your name</span>
        <input
          type="text"
          required
          autoFocus
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded-[--radius-panel] border border-border bg-canvas px-3 py-2.5 text-sm focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/25"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-slate-700">
          Choose a password
        </span>
        <input
          type="password"
          required
          minLength={12}
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
        className="rounded-[--radius-panel] bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 disabled:opacity-60"
      >
        {pending ? "Creating your account…" : "Accept invitation"}
      </button>
    </form>
  );
}
