// App logo (spec 0007 branding): a contact card (person) with a broadcast arc —
// "secure storage that publishes a public contact card." Self-contained: it
// carries its own brand colours, so it sits on the navy header and on a white
// browser tab alike. `src/app/icon.svg` mirrors this for the favicon.
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      role="img"
      aria-label="AW File Storage logo"
    >
      <defs>
        <linearGradient id="aw-logo-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3a92e0" />
          <stop offset="1" stopColor="#1f5d99" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="7.5" fill="url(#aw-logo-g)" />
      {/* contact card */}
      <rect x="6.5" y="8" width="14" height="16.5" rx="2.5" fill="#ffffff" />
      {/* person on the card */}
      <circle cx="13.5" cy="14" r="2.6" fill="#1f5d99" />
      <path d="M9.3 21.4a4.2 4.2 0 0 1 8.4 0z" fill="#1f5d99" />
      {/* published / broadcast */}
      <g fill="none" stroke="#ffffff" strokeWidth="1.7" strokeLinecap="round">
        <path d="M21.8 9.6a4.6 4.6 0 0 1 3.2 3.2" />
        <path d="M22.2 6.4a8.4 8.4 0 0 1 6 6" />
      </g>
    </svg>
  );
}
