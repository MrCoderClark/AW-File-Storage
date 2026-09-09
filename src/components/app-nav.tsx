"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Only routes that exist in this release (spec 0004 AC-2): the mock's other
// tabs (Shared Files, Team Projects, Reports) are intentionally cut. The
// Knowledge base tab (spec 0025) is admin/owner-only and leads to the /kb CMS.
const TABS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/upload-center", label: "Upload Center" },
  { href: "/files", label: "Files" },
  { href: "/create-card", label: "Create Card" },
  { href: "/settings", label: "Settings" },
];

export function AppNav({ canManage = false }: { canManage?: boolean }) {
  const pathname = usePathname();
  const tabs = canManage
    ? [...TABS, { href: "/kb", label: "Knowledge base" }]
    : TABS;
  return (
    <nav
      aria-label="Primary"
      className="flex h-10 items-stretch gap-1 bg-brand-800 px-4 text-sm"
    >
      {tabs.map((tab) => {
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
