import { LogsView } from "@/components/logs-view";
import { requireOrgRole } from "@/server/session";

export const dynamic = "force-dynamic";

// Activity Logs (spec 0018), reached from the "Activity logs" link in the side rail.
// Open to any signed-in member of the org (read-only, no admin controls); the
// /api/logs route re-checks membership.
export default async function ActivityPage() {
  await requireOrgRole("member");
  return <LogsView />;
}
