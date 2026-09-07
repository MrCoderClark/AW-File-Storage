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
    // Weekdays at 13:00 UTC (~9am ET): auto-provision cards from the O365 directory
    // (spec 0016) — a once-a-day catch-up; same-day hires use the in-app button.
    if (event.cron === "0 13 * * 1-5") {
      ctx.waitUntil(callCron(env, "/api/cron/o365-provision"));
      return;
    }
    // Nightly (0 3 * * *): abandoned-upload sweep (spec 0003) + Office 365 reconcile
    // of already-published cards (spec 0010) + purge of offboarded cards past their
    // 30-day grace window (spec 0017). Each is best effort; the O365 endpoints are a
    // no-op unless an org has opted in and configured credentials.
    ctx.waitUntil(callCron(env, "/api/cron/cleanup"));
    ctx.waitUntil(callCron(env, "/api/cron/o365-sync"));
    ctx.waitUntil(callCron(env, "/api/cron/o365-purge"));
  },
};
