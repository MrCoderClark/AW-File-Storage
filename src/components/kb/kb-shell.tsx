"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Logo } from "@/components/logo";
import { signOut } from "@/lib/auth-client";

// The Knowledge base CMS shell (spec 0025): a dark left sidebar (nav + the live category tree)
// and a light main area, distinct from the app's top-nav shell. Admin/owner only (the layout
// gates it). Matches the knowledge-base mock.

interface Category {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
}

const NAV = [
  { href: "/kb/articles", label: "Articles" },
  { href: "/kb/categories", label: "Categories" },
  { href: "/kb/media", label: "Media" },
];

export function KbShell({
  userName,
  userEmail,
  orgName,
  children,
}: {
  userName: string;
  userEmail: string;
  orgName: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [cats, setCats] = useState<Category[]>([]);
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  async function onSignOut() {
    await signOut();
    router.push("/sign-in");
  }

  useEffect(() => {
    fetch("/api/help/categories", { cache: "no-store" })
      .then((r) =>
        r.ok
          ? (r.json() as Promise<{ categories?: Category[] }>)
          : Promise.reject(new Error()),
      )
      .then((b) => setCats(b.categories ?? []))
      .catch(() => {});
  }, [pathname]);

  const tops = cats.filter((c) => !c.parentId);
  const childrenOf = (parent: string) => cats.filter((c) => c.parentId === parent);
  const initials = userName
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const sidebar = (
    <div className="flex h-full w-60 flex-col bg-brand-900 text-white">
      <div className="flex items-center gap-2 px-4 py-4">
        <Logo className="h-8 w-8" />
        <div className="leading-tight">
          <div className="text-sm font-semibold">Knowledge base</div>
          <div className="text-[11px] text-white/50">{orgName}</div>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-2 text-sm">
        {NAV.map((n) => {
          const active = pathname === n.href || pathname.startsWith(`${n.href}/`);
          return (
            <Link
              key={n.href}
              href={n.href}
              onClick={() => setOpen(false)}
              className={`block rounded-[--radius-panel] px-3 py-2 font-medium ${
                active
                  ? "bg-brand-600 text-white"
                  : "text-white/70 hover:bg-white/10 hover:text-white"
              }`}
            >
              {n.label}
            </Link>
          );
        })}
        {tops.length > 0 && (
          <div className="mt-5">
            <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-white/40">
              Categories
            </div>
            <ul>
              {tops.map((c) => (
                <li key={c.id}>
                  <span className="block px-3 py-1.5 text-sm text-white/70">
                    {c.name}
                  </span>
                  {childrenOf(c.id).length > 0 && (
                    <ul className="ml-4 border-l border-white/10">
                      {childrenOf(c.id).map((ch) => (
                        <li key={ch.id}>
                          <span className="block px-3 py-1 text-xs text-white/50">
                            {ch.name}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </nav>
      <div className="border-t border-white/10 p-2">
        <Link
          href="/dashboard"
          className="block rounded-[--radius-panel] px-3 py-2 text-sm text-white/70 hover:bg-white/10 hover:text-white"
        >
          ← Back to app
        </Link>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-canvas">
      <aside className="hidden lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="absolute inset-0 cursor-default bg-slate-900/40"
          />
          <div className="relative h-full">{sidebar}</div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between gap-3 border-b border-border bg-surface px-4">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded p-1.5 text-slate-600 hover:bg-canvas lg:hidden"
            aria-label="Open menu"
          >
            ☰
          </button>
          <div className="flex-1" />
          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className="flex items-center gap-2 rounded-[--radius-panel] p-1 hover:bg-canvas"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white">
                {initials || "?"}
              </span>
              <span className="hidden text-left leading-tight sm:block">
                <span className="block text-sm font-medium text-slate-800">
                  {userName}
                </span>
              </span>
            </button>
            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 z-30 mt-2 w-56 overflow-hidden rounded-[--radius-panel] border border-border bg-surface shadow-lg"
              >
                <div className="border-b border-border px-4 py-3">
                  <div className="text-sm font-medium text-slate-800">{userName}</div>
                  <div className="truncate text-xs text-muted-500">{userEmail}</div>
                </div>
                <Link
                  href="/dashboard"
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                  className="block w-full px-4 py-2.5 text-left text-sm text-slate-700 hover:bg-canvas"
                >
                  ← Back to app
                </Link>
                <button
                  type="button"
                  role="menuitem"
                  onClick={onSignOut}
                  className="block w-full border-t border-border px-4 py-2.5 text-left text-sm text-slate-700 hover:bg-canvas"
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
