import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  type O365ProvisionEnv,
  provisionCardsAllOrgs,
} from "@/server/o365-provision";

// Auto-provision contact cards from the Office 365 directory (spec 0016), triggered
// by the companion cron Worker on a frequent (~10 min) schedule and nightly.
// Authenticated by the same bearer secret + Origin as the other cron endpoints. A
// no-op for any org that has not opted in / has no credentials.
export async function POST(req: Request) {
  const { env } = getCloudflareContext();
  const secret = (env as unknown as { CRON_SECRET?: string }).CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const result = await provisionCardsAllOrgs(env as unknown as O365ProvisionEnv);
  return Response.json({ ok: true, ...result });
}
