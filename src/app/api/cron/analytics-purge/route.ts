import { getCloudflareContext } from "@opennextjs/cloudflare";
import { purgeExpiredVisitEvents, type VisitEnv } from "@/server/visits";

// Nightly retention purge of per-visitor engagement events past the 12-month
// window (spec 0030 AC-9), triggered by the companion cron Worker. Same bearer
// secret as the other cron endpoints. Cross-org and a no-op when nothing is due;
// it never touches the card_stat_daily rollup, which is kept indefinitely.
export async function POST(req: Request) {
  const { env } = getCloudflareContext();
  const secret = (env as unknown as { CRON_SECRET?: string }).CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const result = await purgeExpiredVisitEvents(env as unknown as VisitEnv);
  return Response.json({ ok: true, ...result });
}
