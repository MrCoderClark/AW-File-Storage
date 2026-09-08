import type { NextConfig } from "next";

// The full app Content-Security-Policy (spec 0020). ENFORCED (spec 0020 follow-up):
// proven against the live app in report-only first, then promoted. Everything the app
// loads is same-origin: bundled Tailwind CSS, same-host images (logos, the QR endpoint,
// social PNGs), `data:` images, and same-origin fetches to /api. No third-party
// script/style/font/img origin is used, so the policy is tight except for the inline
// script/style Next.js and the inline-styled pages require.
//
// `img-src` also allows the public file domain (contacts.awvcard.com): because this is
// now ENFORCED on every path, it also applies to the /c card pages, and a browser
// enforces the INTERSECTION of this policy and that route's own strict CSP. That route
// allows the public domain for an org's uploaded state logo, so this must too or the
// intersection would re-block it on the app-host preview. Scripts stay blocked on /c
// (its `default-src 'none'` wins the intersection), so the card pages remain script-free.
//
// NOTE: `script-src` keeps `'unsafe-inline'` (Option A) — it blocks foreign scripts,
// object/embed, base-uri hijacking and cross-origin exfiltration, but not an injected
// INLINE script. Tightening to a per-request nonce is an optional future step; the one
// surface that renders user-supplied content (the /c page) is already script-free.
const APP_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' https://contacts.awvcard.com data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
].join("; ");

// Security headers on every response (spec 0020). One owner for the whole app so no
// route can silently drop them:
//  - HSTS pins HTTPS for future requests.
//  - nosniff stops content-type sniffing (matters for the served .vcf / logos).
//  - X-Frame-Options: DENY blocks clickjacking on older browsers; APP_CSP's enforced
//    `frame-ancestors 'none'` covers modern ones. Both kept, belt-and-suspenders.
//  - Referrer-Policy / Permissions-Policy trim what leaves the app.
//  - Content-Security-Policy (APP_CSP) is now ENFORCED. On the /c card pages it
//    intersects with that route's own stricter CSP (a safe intersection — see APP_CSP);
//    on every other path it is the sole policy.
const SECURITY_HEADERS = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  { key: "Content-Security-Policy", value: APP_CSP },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;

// Enables the Cloudflare bindings (D1, R2, env) in `next dev`, so local
// development runs against the same binding shapes as production.
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
