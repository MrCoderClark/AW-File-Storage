import { getCloudflareContext } from "@opennextjs/cloudflare";
import { type O365SyncEnv, reconcileO365 } from "@/server/o365-sync";
import { requireApiRole } from "@/server/session";

// "Sync all now" (spec 0010): run the reconcile on demand instead of waiting for
// the nightly cron. Owner/admin only. A no-op (processed: 0) when the toggle is
// off or credentials are absent.
export async function POST() {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { env } = getCloudflareContext();
  const result = await reconcileO365(env as unknown as O365SyncEnv);
  return Response.json({ ok: true, ...result });
}
