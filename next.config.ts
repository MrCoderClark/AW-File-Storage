import type { NextConfig } from "next";

// The full app Content-Security-Policy (spec 0020). Shipped in REPORT-ONLY first so
// it can be proven against the live app (Next.js injects inline bootstrap scripts;
// the app and the signature preview use inline styles) before it is enforced. Once
// the browser console is confirmed free of violations, promote the header name from
// `Content-Security-Policy-Report-Only` to `Content-Security-Policy` below.
//
// Everything the app loads is same-origin: bundled Tailwind CSS, same-host images
// (logos, the QR endpoint, social PNGs), `data:` images, and same-origin fetches to
// /api. No third-party script/style/font/img origin is used, so the policy is tight
// except for the inline script/style Next.js and the inline-styled pages require.
const APP_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  // 'unsafe-inline' covers Next.js's inline bootstrap/streaming scripts. Tightening
  // this to a per-request nonce is the follow-up before flipping to enforce.
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
].join("; ");

// Security headers on every response (spec 0020). One owner for the whole app so no
// route can silently drop them. All safe to enforce immediately:
//  - HSTS pins HTTPS for future requests.
//  - nosniff stops content-type sniffing (matters for the served .vcf / logos).
//  - X-Frame-Options: DENY blocks clickjacking on every browser (the newer
//    `frame-ancestors` directive adds nothing here — no browser honors it but not
//    XFO — so this file sets no *enforced* Content-Security-Policy. That leaves the
//    header key free for the public card route to set its own strict, enforced CSP;
//    a config `Content-Security-Policy` would otherwise override a handler-set one.
//    When APP_CSP below is promoted to enforced, it carries `frame-ancestors 'none'`.)
//  - Referrer-Policy / Permissions-Policy trim what leaves the app.
// The full app policy rides along as report-only until it is promoted to enforced.
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
  { key: "Content-Security-Policy-Report-Only", value: APP_CSP },
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
