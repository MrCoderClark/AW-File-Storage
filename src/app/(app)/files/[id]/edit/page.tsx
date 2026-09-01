import { getCloudflareContext } from "@opennextjs/cloudflare";
import { notFound, redirect } from "next/navigation";
import { CreateCardForm } from "@/components/create-card-form";
import { cardFieldsFromParsed } from "@/lib/vcard-builder";
import { getCardForSignature } from "@/server/signature";
import { getActor } from "@/server/session";
import type { UploadEnv } from "@/server/uploads";

// Edit a published contact card (spec 0006 follow-up). Reuses the Create Card
// wizard, pre-filled from the stored .vcf, and re-publishes under the same slug.
// Authenticated + org-scoped; only a published vCard in the caller's org resolves.
export const dynamic = "force-dynamic";

export default async function EditCardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect("/sign-in");
  const { id } = await params;

  const { env } = getCloudflareContext();
  const resolved = await getCardForSignature(
    env as unknown as UploadEnv,
    actor,
    id,
  );
  if (!resolved) notFound();

  const initial = cardFieldsFromParsed(resolved.card);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex flex-col items-center text-center">
        <h1 className="text-2xl font-semibold text-brand-900">
          Edit contact card
        </h1>
        <p className="mt-1 text-sm text-muted-500">
          Changes republish to the same public address — the card&apos;s URL and
          any printed QR keep working.
        </p>
      </div>

      <div className="mt-6">
        <CreateCardForm initial={initial} editFileId={id} />
      </div>
    </div>
  );
}
