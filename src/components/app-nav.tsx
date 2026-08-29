"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Only routes that exist in this release (spec 0004 AC-2): the mock's other
// tabs (Shared Files, Team Projects, Reports) are intentionally cut.
const TABS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/upload-center", label: "Upload Center" },
  { href: "/create-card", label: "Create Card" },
  { href: "/settings", label: "Settings" },
];

export function AppNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary"
      className="flex h-10 items-stretch gap-1 bg-brand-800 px-4 text-sm"
    >
      {TABS.map((tab) => {
        const active =
          pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`flex items-center border-b-2 px-3 font-medium transition-colors ${
              active
                ? "border-accent-500 text-white"
                : "border-transparent text-white/70 hover:text-white"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
