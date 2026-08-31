import { getCloudflareContext } from "@opennextjs/cloudflare";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { SignatureView } from "@/components/signature-view";
import { AW_SIGNATURE_BRAND } from "@/lib/signature-brand";
import { buildSignatureHtml } from "@/lib/signature-html";
import { getCardForSignature } from "@/server/signature";
import { getActor } from "@/server/session";
import type { UploadEnv } from "@/server/uploads";

// Printable / copyable signature for a published vCard (spec 0009). Lives inside
// the app shell (header + nav + side rail); the shell chrome and the page's own
// toolbar are `print:hidden`, so a print / Save-as-PDF captures the signature
// alone. Authenticated + org-scoped: only a member of the card's org can open it.
export const dynamic = "force-dynamic";

export default async function SignaturePage({
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

  // Absolute origin for the hosted logo + QR (email clients need absolute URLs).
  // Prefer the configured APP_URL; fall back to the request host.
  const appUrl = (env as unknown as { APP_URL?: string }).APP_URL;
  const host = (await headers()).get("host");
  const base = (appUrl ?? (host ? `https://${host}` : "")).replace(/\/+$/, "");

  const brand = AW_SIGNATURE_BRAND;
  const input = {
    card: resolved.card,
    publicUrl: resolved.publicUrl,
    qrUrl: `${base}/api/cards/${resolved.id}/qr`,
    baseUrl: base,
    brand,
  };

  return (
    <SignatureView
      name={resolved.name}
      fullName={resolved.card.fullName}
      publicUrl={resolved.publicUrl}
      html={buildSignatureHtml(input)}
    />
  );
}
