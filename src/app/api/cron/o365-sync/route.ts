import { getCloudflareContext } from "@opennextjs/cloudflare";
import { type O365SyncEnv, reconcileO365 } from "@/server/o365-sync";

// Nightly Office 365 reconcile (spec 0010), triggered by the companion cron
// Worker. Authenticated by the same bearer secret + Origin as the cleanup cron.
// A no-op (processed: 0) when the sync is not enabled/configured.
export async function POST(req: Request) {
  const { env } = getCloudflareContext();
  const secret = (env as unknown as { CRON_SECRET?: string }).CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const result = await reconcileO365(env as unknown as O365SyncEnv);
  return Response.json({ ok: true, ...result });
}
