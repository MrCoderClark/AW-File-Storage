interface Env {
  APP_URL: string;
  CRON_SECRET: string;
}

// Standalone cron Worker: OpenNext's app worker exposes only `fetch`, so the
// nightly sweep runs from this tiny companion worker, which calls the app's
// bearer-authenticated cleanup endpoint on a schedule (spec 0003 AC-14).
// POST one of the app's bearer-authenticated cron endpoints. The app's proxy.ts
// CSRF guard rejects a mutating request whose Origin host doesn't match the
// request host, so send an Origin equal to APP_URL (also the request host here).
async function callCron(env: Env, path: string): Promise<void> {
  const res = await fetch(`${env.APP_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CRON_SECRET}`,
      Origin: env.APP_URL,
    },
  });
  console.log(path, res.status, await res.text());
}

export default {
  async scheduled(
    event: { cron?: string },
    env: Env,
    ctx: { waitUntil(p: Promise<unknown>): void },
  ) {
    // Every 5 minutes: flush due scheduled emails (spec 0015 SCIM set-password).
    if (event.cron === "*/5 * * * *") {
      ctx.waitUntil(callCron(env, "/api/cron/flush-emails"));
      return;
    }
    // Nightly (0 3 * * *): sweep (spec 0003) + Office 365 reconcile (spec 0010).
    // Each is best effort; the O365 endpoint is a no-op unless the sync is configured.
    ctx.waitUntil(callCron(env, "/api/cron/cleanup"));
    ctx.waitUntil(callCron(env, "/api/cron/o365-sync"));
  },
};
