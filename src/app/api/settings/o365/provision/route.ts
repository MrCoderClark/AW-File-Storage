import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  type O365ProvisionEnv,
  provisionCardsForOrg,
} from "@/server/o365-provision";
import { requireApiRole } from "@/server/session";

// "Provision new users now" (spec 0016): run the directory sweep for THIS org on
// demand — create cards for licensed users added since the feature was enabled, and
// unpublish auto-cards for offboarded users. Owner/admin only. A no-op when the
// auto-card toggle is off or credentials are absent. Separate from the reconcile of
// already-published cards (.../o365/sync).
export async function POST() {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { env } = getCloudflareContext();
  const result = await provisionCardsForOrg(
    env as unknown as O365ProvisionEnv,
    auth.actor.orgId,
  );
  return Response.json({ ok: true, ...result });
}
