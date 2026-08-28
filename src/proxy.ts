import { type NextRequest, NextResponse } from "next/server";

// Cross-site request forgery defence, enforced in ONE place for every route and
// every server action (spec 0001 AC-8). Better Auth also checks its own routes
// against trustedOrigins; this covers our own actions/routes too.
//
// Next 16 renamed the "middleware" convention to "proxy" (same functionality).
//
// State-changing requests must carry an `Origin` that matches the request host.
// Same-origin browser POSTs always send Origin, so this rejects cross-site
// forgeries without affecting legitimate use.
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function proxy(req: NextRequest) {
  if (!MUTATING.has(req.method)) return NextResponse.next();

  // Bearer-authenticated machine endpoints (no cookies) are not CSRF-exposed.
  const path = req.nextUrl.pathname;
  if (path.startsWith("/api/cron/") || path.startsWith("/api/admin/")) {
    return NextResponse.next();
  }

  const origin = req.headers.get("origin");
  // HTTP/2/3 carries the host as the `:authority` pseudo-header, and a proxy in
  // front of us may forward it as `x-forwarded-host`, so a literal `Host` header
  // is not guaranteed. `nextUrl.host` is the last resort.
  const host =
    req.headers.get("host") ?? req.headers.get("x-forwarded-host") ?? req.nextUrl.host;

  if (!origin || !host) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return new NextResponse("Forbidden", { status: 403 });
  }
  if (originHost !== host) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  return NextResponse.next();
}

export const config = {
  // Run on everything except static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
