import { getCloudflareContext } from "@opennextjs/cloudflare";
import { type AuthEnv } from "@/server/auth";
import { flushPendingEmails } from "@/server/pending-email";

// Send due scheduled emails (spec 0015) — the SCIM set-password emails, deferred
// ~5 min for mailbox readiness. Triggered every 5 minutes by the companion cron
// worker; bearer `CRON_SECRET` + Origin, like the other cron endpoints.
export async function POST(req: Request) {
  const { env } = getCloudflareContext();
  const secret = (env as unknown as { CRON_SECRET?: string }).CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const result = await flushPendingEmails(env as unknown as AuthEnv);
  return Response.json({ ok: true, ...result });
}
