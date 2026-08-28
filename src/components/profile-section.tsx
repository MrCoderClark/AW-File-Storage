"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

// Self-service profile: a member can update their own display name (spec 0005
// scope extension). Email is read-only (it's the login identity).
export function ProfileSection({
  initialName,
  email,
}: {
  initialName: string;
  email: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty = name.trim() !== initialName && name.trim().length > 0;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setMessage(null);
    setError(null);
    try {
      const { error: err } = await authClient.updateUser({ name: name.trim() });
      if (err) throw new Error(err.message ?? "Could not update your name.");
      setMessage("Saved.");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update your name.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="rounded-[--radius-panel] border border-border bg-surface p-5">
      <h2 className="text-base font-semibold text-slate-800">Your profile</h2>
      <form onSubmit={save} className="mt-4 flex flex-col gap-4 sm:max-w-md">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-700">Name</span>
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded-[--radius-panel] border border-border bg-canvas px-3 py-2 text-sm focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/25"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-700">Email</span>
          <input
            type="email"
            value={email}
            readOnly
            disabled
            className="rounded-[--radius-panel] border border-border bg-canvas px-3 py-2 text-sm text-muted-500"
          />
        </label>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending || !dirty}
            className="rounded-[--radius-panel] bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save"}
          </button>
          {message && <span className="text-sm text-emerald-700">{message}</span>}
          {error && <span className="text-sm text-danger-600">{error}</span>}
        </div>
      </form>
    </section>
  );
}
