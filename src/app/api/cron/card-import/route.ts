import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  type CardImportEnv,
  continueDrainViaFetch,
  runDrainRun,
} from "@/server/card-import";

// Drain pending bulk-import rows (spec 0028 AC-6). This is NOT a periodic cron: imports
// normally publish in-process in the background of the submit request. This endpoint is
// the CONTINUATION for a large import (a fresh invocation with a fresh subrequest budget)
// and the nightly safety-net entry point. It drains one bounded run in-process and, if
// rows still remain, hands off to another invocation. Same bearer secret as the other
// cron endpoints. Safe to run concurrently and to re-run (AC-13).
export async function POST(req: Request) {
  const { env, ctx } = getCloudflareContext();
  const e = env as unknown as CardImportEnv;
  const secret = (env as unknown as { CRON_SECRET?: string }).CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const result = await runDrainRun(e);
  // More rows remained after this run's batch cap — continue in a fresh invocation.
  if (result.more) {
    try {
      ctx.waitUntil(continueDrainViaFetch(e));
    } catch {
      // No context — the nightly safety net will finish any remaining rows.
    }
  }
  return Response.json({ ok: true, ...result });
}
