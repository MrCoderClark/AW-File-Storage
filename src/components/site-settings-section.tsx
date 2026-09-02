"use client";

import { useEffect, useState } from "react";

// Site-wide settings (spec 0009 follow-up). Owner/admin only. Currently one
// toggle: whether card pages on the app site (www) require a sign-in. The public
// domain (contacts) is always public and unaffected.
export function SiteSettingsSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/settings/site", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as {
          settings: { requireAppHostCardLogin: boolean };
        };
        setEnabled(body.settings.requireAppHostCardLogin);
      } catch {
        setError("Could not load site settings.");
      }
    })();
  }, []);

  async function toggle(next: boolean) {
    setSaving(true);
    setError("");
    const prev = enabled;
    setEnabled(next); // optimistic
    try {
      const res = await fetch("/api/settings/site", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requireAppHostCardLogin: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setEnabled(prev ?? null); // revert
      setError("Could not save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-xl font-semibold text-brand-900">Site</h1>
      <p className="mt-1 text-sm text-muted-500">
        Site-wide settings for how card pages are served.
      </p>

      <div className="mt-5 rounded-[--radius-panel] border border-border bg-surface p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-800">
              Require sign-in for card pages on the app site
            </p>
            <p className="mt-1 text-sm text-muted-500">
              When on, a card page opened on{" "}
              <code className="rounded bg-canvas px-1 py-0.5 text-xs">www.awvcard.com/c/…</code>{" "}
              requires a signed-in staff member (a logged-out visitor is sent to
              sign-in). The public address{" "}
              <code className="rounded bg-canvas px-1 py-0.5 text-xs">contacts.awvcard.com</code>{" "}
              is always public and is unaffected, so QR codes, email signatures,
              and the Office 365 link keep working. Engagement counts always come
              only from the public address, whichever way this is set.
            </p>
          </div>
          <Switch
            checked={enabled === true}
            disabled={enabled === null || saving}
            onChange={toggle}
            label="Require sign-in for card pages on the app site"
          />
        </div>
        {enabled === null && !error && (
          <p className="mt-3 text-xs text-muted-500">Loading…</p>
        )}
        {error && <p className="mt-3 text-xs text-danger-600">{error}</p>}
      </div>
    </div>
  );
}

function Switch({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
        checked ? "bg-brand-600" : "bg-slate-300"
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
