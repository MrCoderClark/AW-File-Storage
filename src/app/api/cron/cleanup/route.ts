import { getCloudflareContext } from "@opennextjs/cloudflare";
import { type CleanupEnv, runCleanup } from "@/server/cleanup";

// Scheduled cleanup, triggered by the companion cron Worker (see cron/).
// Authenticated by a bearer secret rather than a session, so it is exempt from
// the origin/CSRF check in proxy.ts.
export async function POST(req: Request) {
  const { env } = getCloudflareContext();
  const secret = (env as unknown as { CRON_SECRET?: string }).CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const result = await runCleanup(env as unknown as CleanupEnv);
  return Response.json({ ok: true, ...result });
}
