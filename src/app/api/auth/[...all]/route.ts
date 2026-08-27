import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/server/auth";

// Better Auth mounts all its flows (sign-in, sign-out, session, org, 2FA) under
// /api/auth/*. The instance is built per request because the D1 binding only
// exists in request scope.
async function handler(req: Request) {
  const { GET, POST } = toNextJsHandler(getAuth());
  return req.method === "GET" ? GET(req) : POST(req);
}

export { handler as GET, handler as POST };
