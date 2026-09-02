import { getCloudflareContext } from "@opennextjs/cloudflare";
import { buildCardLandingHtml } from "@/lib/card-landing-html";
import { AW_SIGNATURE_BRAND, logoForState } from "@/lib/signature-brand";
import {
  isCountableUserAgent,
  recordCardHit,
  type CardMetric,
} from "@/server/card-stats";
import { r2GetText } from "@/server/r2";
import { resolveCardBySlug } from "@/server/signature";
import { getStateLogoUrl, resolveSocials } from "@/server/social-links";
import { publicKeyFor, type UploadEnv } from "@/server/uploads";
import { parseVcard } from "@/server/vcard";

// Public serving for a published contact card (spec 0008), on the contacts host
// (and reachable on www before the domain cutover, which is how we verify it).
// ONE GET handler for two shapes under /c/:
//   /c/<slug>       → the styled HTML landing page; counts a view (or a scan
//                     when ?src=qr), so a QR that points here registers a scan.
//   /c/<slug>.vcf   → the vCard bytes, byte-and-type identical to what R2 served
//                     before, so every printed QR and email signature still works;
//                     counts a download.
// Counting is fire-and-forget via ctx.waitUntil and never blocks or fails the
// response (AC-5). Both responses carry noindex and are not edge-cached, so every
// hit reaches the Worker to be counted.
export const dynamic = "force-dynamic";

const NOINDEX = "noindex, nofollow";
const NO_CACHE = "private, no-store";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug: rawSlug } = await params;
  const { env: rawEnv, ctx } = getCloudflareContext();
  const env = rawEnv as unknown as UploadEnv;

  const isDownload = rawSlug.toLowerCase().endsWith(".vcf");
  const slug = isDownload ? rawSlug.slice(0, -4) : rawSlug;

  const ref = await resolveCardBySlug(env, slug);
  if (!ref) {
    // Unknown or unpublished slug: 404, no count (AC-6).
    return new Response("Not found", {
      status: 404,
      headers: { "X-Robots-Tag": NOINDEX, "Cache-Control": NO_CACHE },
    });
  }

  const cfg = {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  };
  const raw = await r2GetText(cfg, env.R2_PUBLIC_BUCKET, publicKeyFor(slug));
  if (raw === null) {
    // Row says published but the object is gone: treat as not found, no count.
    return new Response("Not found", {
      status: 404,
      headers: { "X-Robots-Tag": NOINDEX, "Cache-Control": NO_CACHE },
    });
  }

  const userAgent = req.headers.get("user-agent");
  const countable = isCountableUserAgent(userAgent);
  const count = (metric: CardMetric) => {
    if (!countable) return;
    ctx.waitUntil(
      recordCardHit(env, { fileId: ref.fileId, orgId: ref.orgId, metric }),
    );
  };

  if (isDownload) {
    count("download");
    return new Response(raw, {
      headers: {
        "Content-Type": "text/vcard; charset=utf-8",
        "Content-Disposition": `attachment; filename="${slug}.vcf"`,
        "Cache-Control": NO_CACHE,
        "X-Robots-Tag": NOINDEX,
      },
    });
  }

  // Landing page: a QR-sourced load is a scan, a `preview=1` load is a staff
  // preview from the Files page (not counted), otherwise a plain visitor view.
  const url = new URL(req.url);
  const isScan = url.searchParams.get("src") === "qr";
  const isPreview = url.searchParams.has("preview");
  if (!isPreview) count(isScan ? "scan" : "view");

  const card = parseVcard(raw);
  const state = card.address.state;
  const socials = await resolveSocials(env, ref.orgId, state);
  // Prefer the org's admin-assigned per-state logo (same as the signature); fall
  // back to the built-in state logo when none is uploaded.
  const uploadedLogo = await getStateLogoUrl(env, ref.orgId, state);
  const baseUrl = url.origin;
  const logoUrl = uploadedLogo ?? `${baseUrl}${logoForState(AW_SIGNATURE_BRAND, state)}`;
  const html = buildCardLandingHtml({
    card,
    vcfUrl: `${baseUrl}/c/${slug}.vcf`,
    qrUrl: `${baseUrl}/api/cards/${ref.fileId}/qr`,
    logoUrl,
    baseUrl,
    canonicalUrl: `${baseUrl}/c/${slug}`,
    socials,
    brand: AW_SIGNATURE_BRAND,
  });

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": NO_CACHE,
      "X-Robots-Tag": NOINDEX,
    },
  });
}
