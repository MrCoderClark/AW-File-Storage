"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { signOut } from "@/lib/auth-client";

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
}: {
  userName: string;
  userEmail: string;
  orgName: string;
  role: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
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

  return (
    <header className="flex h-14 items-center gap-4 bg-brand-900 px-4 text-white">
      {/* Logo */}
      <div className="flex items-center gap-2">
        <CloudIcon className="h-7 w-7 text-accent-500" />
        <div className="leading-tight">
          <div className="font-semibold">{appName}</div>
          {orgName && (
            <div className="text-[11px] text-white/60">{orgName}</div>
          )}
        </div>
      </div>

      {/* Search */}
      <div className="mx-auto hidden w-full max-w-md items-center sm:flex">
        <div className="flex w-full items-center gap-2 rounded-[--radius-panel] bg-white/10 px-3 py-1.5 text-sm text-white/80 focus-within:bg-white/15">
          <SearchIcon className="h-4 w-4 shrink-0 text-white/50" />
          <input
            type="search"
            placeholder="Search files"
            aria-label="Search files"
            className="w-full bg-transparent placeholder:text-white/40 focus:outline-none"
          />
        </div>
      </div>

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

function CloudIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M6.5 19a4.5 4.5 0 0 1-.36-8.99A6 6 0 0 1 17.7 8.6 4.7 4.7 0 0 1 17.5 19h-11Z" />
    </svg>
  );
}
function SearchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" strokeLinecap="round" />
    </svg>
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
function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
