interface Env {
  APP_URL: string;
  CRON_SECRET: string;
}

// Standalone cron Worker: OpenNext's app worker exposes only `fetch`, so the
// nightly sweep runs from this tiny companion worker, which calls the app's
// bearer-authenticated cleanup endpoint on a schedule (spec 0003 AC-14).
async function runSweep(env: Env): Promise<void> {
  const res = await fetch(`${env.APP_URL}/api/cron/cleanup`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CRON_SECRET}`,
      // The app's proxy.ts CSRF guard rejects a mutating request whose Origin
      // host doesn't match the request host, and the `/api/cron/` path-exemption
      // does NOT fire on the Cloudflare runtime — so send an Origin equal to
      // APP_URL (which is also the request host here) to pass the check.
      Origin: env.APP_URL,
    },
  });
  console.log("cleanup", res.status, await res.text());
}

export default {
  async scheduled(
    _event: unknown,
    env: Env,
    ctx: { waitUntil(p: Promise<unknown>): void },
  ) {
    ctx.waitUntil(runSweep(env));
  },
};
