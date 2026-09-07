import { getCloudflareContext } from "@opennextjs/cloudflare";
import { purgeOffboardedCards, type UploadEnv } from "@/server/uploads";

// Nightly purge of offboarded cards past their 30-day grace window (spec 0017),
// triggered by the companion cron Worker. Same bearer secret as the other cron
// endpoints. Cross-org; a no-op when nothing is due.
export async function POST(req: Request) {
  const { env } = getCloudflareContext();
  const secret = (env as unknown as { CRON_SECRET?: string }).CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const result = await purgeOffboardedCards(env as unknown as UploadEnv);
  return Response.json({ ok: true, ...result });
}
