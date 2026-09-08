"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Side navigation for the Settings hub (each section is its own page). A
// horizontal scroll strip below `lg`, a vertical sidebar at `lg+`. Admin-only
// links are passed in via `canManage`; the pages themselves re-check the role.
type NavItem = { href: string; label: string; match?: string[] };

const BASE: NavItem[] = [
  { href: "/settings/profile", label: "Profile" },
  { href: "/settings/security", label: "Security" },
];

const ADMIN: NavItem[] = [
  { href: "/settings/organization", label: "Organization" },
  // The member detail page lives at /settings/users/[id]; keep Members lit there.
  { href: "/settings/members", label: "Members", match: ["/settings/members", "/settings/users"] },
  { href: "/settings/invitations", label: "Invitations" },
  { href: "/settings/social-links", label: "Regional social links" },
  { href: "/settings/o365", label: "Office 365" },
  { href: "/settings/site", label: "Site" },
  { href: "/settings/help", label: "Help articles" },
];

const PLATFORM: NavItem[] = [
  { href: "/settings/provisioning", label: "Provisioning" },
];

export function SettingsNav({
  canManage,
  isPlatformOwner = false,
}: {
  canManage: boolean;
  isPlatformOwner?: boolean;
}) {
  const pathname = usePathname();
  const items = [
    ...BASE,
    ...(canManage ? ADMIN : []),
    ...(isPlatformOwner ? PLATFORM : []),
  ];

  return (
    <nav
      aria-label="Settings sections"
      className="flex gap-1 overflow-x-auto border-b border-border pb-2 lg:flex-col lg:overflow-visible lg:border-b-0 lg:pb-0"
    >
      {items.map((item) => {
        const matches = item.match ?? [item.href];
        const active = matches.some(
          (m) => pathname === m || pathname.startsWith(`${m}/`),
        );
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`shrink-0 whitespace-nowrap rounded-[--radius-panel] px-3 py-2 text-sm font-medium transition-colors ${
              active
                ? "bg-brand-600 text-white"
                : "text-slate-700 hover:bg-canvas"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
