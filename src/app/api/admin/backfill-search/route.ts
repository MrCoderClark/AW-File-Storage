import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requireApiRole } from "@/server/session";
import { backfillSearchFields, type UploadEnv } from "@/server/uploads";

// One-time, idempotent backfill of the denormalised search columns (category +
// vCard contact fields) for existing files. Owner-only; safe to re-run. Can be
// removed once every org has been backfilled.
export async function POST() {
  const auth = await requireApiRole("owner");
  if (!auth.ok) return auth.response;
  const { env } = getCloudflareContext();
  const { updated } = await backfillSearchFields(env as unknown as UploadEnv, {
    orgId: auth.actor.orgId,
    userId: auth.actor.userId,
    canManageAny: true,
  });
  return Response.json({ ok: true, updated });
}
