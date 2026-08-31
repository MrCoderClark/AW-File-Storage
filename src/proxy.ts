import { type NextRequest, NextResponse } from "next/server";

// Cross-site request forgery defence, enforced in ONE place for every route and
// every server action (spec 0001 AC-8). Better Auth also checks its own routes
// against trustedOrigins; this covers our own actions/routes too.
//
// Next 16 renamed the "middleware" convention to "proxy" (same functionality).
//
// State-changing requests must carry an `Origin` that matches the request host —
// browsers send it on same-origin POSTs, and our bearer-authenticated machine
// callers (the cron worker, the admin bootstrap) send `Origin: <APP_URL>`
// explicitly, so the check is uniform with no path-based exemption. (An earlier
// `/api/cron/`+`/api/admin/` skip was dead code — it never fired on the
// Cloudflare runtime — so it was removed.)
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function proxy(req: NextRequest) {
  if (!MUTATING.has(req.method)) return NextResponse.next();

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
