import { ActivityTabs } from "@/components/activity-tabs";
import { LogsView } from "@/components/logs-view";
import { requireOrgRole } from "@/server/session";

export const dynamic = "force-dynamic";

// Activity Logs (spec 0018) + Analytics (spec 0030), reached from the "Activity
// logs" link in the side rail. Open to any signed-in member of the org for the
// logs (read-only); owners/admins additionally get the Analytics tab (the
// per-visitor engagement feed), which the /api/analytics/visitors route re-gates.
export default async function ActivityPage() {
  const { role } = await requireOrgRole("member");
  const canViewAnalytics = role === "owner" || role === "admin";
  // Members see the logs only (no Analytics tab, AC-7); owners/admins get tabs.
  return canViewAnalytics ? <ActivityTabs /> : <LogsView />;
}
