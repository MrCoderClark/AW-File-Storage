"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Logo } from "@/components/logo";
import { authClient, signOut } from "@/lib/auth-client";

interface OrgSummary {
  id: string;
  name: string;
}

const appName = process.env.NEXT_PUBLIC_APP_NAME ?? "AW File Storage";

const roleLabel: Record<string, string> = {
  owner: "Owner",
  admin: "Administrator",
  member: "Member",
};

export function AppHeader({
  userName,
  userEmail,
  orgName,
  role,
  activeOrgId,
  orgs,
}: {
  userName: string;
  userEmail: string;
  orgName: string;
  role: string;
  activeOrgId: string;
  orgs: OrgSummary[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const initials = userName
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  async function onSignOut() {
    await signOut();
    router.push("/sign-in");
  }

  async function switchOrg(organizationId: string) {
    if (organizationId === activeOrgId || switching) return;
    setSwitching(true);
    try {
      await authClient.organization.setActive({ organizationId });
      setOpen(false);
      // A full reload guarantees every panel — including the client islands that
      // seed from server data (rail) or fetch on mount (file list) — reloads for
      // the new organization (AC-17). router.refresh() alone leaves their local
      // state on the previous org.
      window.location.reload();
    } catch {
      setSwitching(false);
    }
  }

  const canSwitch = orgs.length > 1;

  return (
    <header className="flex h-14 items-center gap-4 bg-brand-900 px-4 text-white">
      {/* Logo */}
      <div className="flex items-center gap-2">
        <Logo className="h-8 w-8" />
        <div className="leading-tight">
          <div className="font-semibold">{appName}</div>
          {orgName && (
            <div className="text-[11px] text-white/60">{orgName}</div>
          )}
        </div>
      </div>

      <div className="flex-1" />

      {/* Bell */}
      <button
        type="button"
        aria-label="Notifications"
        className="relative rounded-full p-1.5 hover:bg-white/10"
      >
        <BellIcon className="h-5 w-5" />
      </button>

      {/* User menu */}
      <div ref={menuRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          className="flex items-center gap-2 rounded-[--radius-panel] p-1 hover:bg-white/10"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold">
            {initials || "?"}
          </span>
          <span className="hidden text-left leading-tight md:block">
            <span className="block text-sm font-medium">{userName}</span>
            <span className="block text-[11px] text-white/60">
              {roleLabel[role] ?? role}
            </span>
          </span>
          <ChevronIcon className="hidden h-4 w-4 text-white/60 md:block" />
        </button>

        {open && (
          <div
            role="menu"
            className="absolute right-0 z-20 mt-2 w-56 overflow-hidden rounded-[--radius-panel] border border-border bg-surface text-slate-900 shadow-lg"
          >
            <div className="border-b border-border px-4 py-3">
              <div className="text-sm font-medium">{userName}</div>
              <div className="truncate text-xs text-muted-500">{userEmail}</div>
            </div>
            {canSwitch && (
              <div className="border-b border-border py-1.5">
                <div className="px-4 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-500">
                  Organization
                </div>
                {orgs.map((o) => {
                  const active = o.id === activeOrgId;
                  return (
                    <button
                      key={o.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      disabled={switching}
                      onClick={() => void switchOrg(o.id)}
                      className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left text-sm hover:bg-canvas disabled:opacity-50"
                    >
                      <span className="truncate">{o.name}</span>
                      {active && (
                        <CheckIcon className="h-4 w-4 shrink-0 text-accent-500" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={onSignOut}
              className="block w-full px-4 py-2.5 text-left text-sm hover:bg-canvas"
            >
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

function BellIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" strokeLinecap="round" />
    </svg>
  );
}
function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
      <path d="m5 12 5 5L20 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
