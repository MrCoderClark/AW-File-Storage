interface Env {
  APP_URL: string;
  CRON_SECRET: string;
}

// Standalone cron Worker: OpenNext's app worker exposes only `fetch`, so the
// nightly sweep runs from this tiny companion worker, which calls the app's
// bearer-authenticated cleanup endpoint on a schedule.
export default {
  async scheduled(
    _event: unknown,
    env: Env,
    ctx: { waitUntil(p: Promise<unknown>): void },
  ) {
    ctx.waitUntil(
      fetch(`${env.APP_URL}/api/cron/cleanup`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.CRON_SECRET}` },
      }).then(async (res) => {
        console.log("cleanup", res.status, await res.text());
      }),
    );
  },
};
