import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAppSettings } from "@/server/app-settings";
import { buildCardLandingHtml } from "@/lib/card-landing-html";
import { AW_SIGNATURE_BRAND, logoForState } from "@/lib/signature-brand";
import {
  isCountableUserAgent,
  recordCardHit,
  type CardMetric,
} from "@/server/card-stats";
import { r2GetText } from "@/server/r2";
import { getSession } from "@/server/session";
import { resolveCardBySlug } from "@/server/signature";
import { getStateLogoUrl, resolveSocials } from "@/server/social-links";
import { publicKeyFor, type UploadEnv } from "@/server/uploads";
import { parseVcard } from "@/server/vcard";

// Serving for a published contact card, split by request host (spec 0009).
// ONE GET handler for two shapes under /c/:
//   /c/<slug>       → the styled HTML landing page (a scan when ?src=qr).
//   /c/<slug>.vcf   → the vCard bytes, byte-and-type identical to what R2 served.
//
// The PUBLIC host (contacts.awvcard.com = PUBLIC_FILE_DOMAIN) serves both to
// anyone — QR codes, email signatures, and the Office 365 .vcf link depend on it.
// It is the only surface that COUNTS (real outside traffic).
// The APP host (www.awvcard.com, and any other non-public host) serves /c/ only
// as a logged-in staff preview: it requires a session (redirect to /sign-in
// otherwise) and NEVER counts, so staff activity can't inflate the analytics.
//
// Counting is fire-and-forget via ctx.waitUntil and never blocks the response.
// Both responses carry noindex and are not edge-cached.
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

  const url = new URL(req.url);
  const publicDomain = env.PUBLIC_FILE_DOMAIN ?? "contacts.americaworks.com";
  const isPublicHost = url.host === publicDomain;

  // Gate the app host before resolving anything, so a logged-out visitor is
  // bounced to sign-in whether or not the slug exists (no existence leak). The
  // gate is controlled by a site setting (Settings, owner/admin) so it can be
  // turned off to make www serve card pages publicly too (spec 0009 follow-up).
  if (!isPublicHost) {
    const { requireAppHostCardLogin } = await getAppSettings(env);
    if (requireAppHostCardLogin) {
      const session = await getSession();
      if (!session) {
        return Response.redirect(new URL("/sign-in", url).toString(), 302);
      }
    }
  }

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
  // Count only real, public-host traffic. App-host hits are logged-in staff
  // previews (already gated above) and never count (spec 0009).
  const count = (metric: CardMetric) => {
    if (!isPublicHost || !countable) return;
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

  // Landing page: a QR-sourced load is a scan, otherwise a plain view.
  const isScan = url.searchParams.get("src") === "qr";
  count(isScan ? "scan" : "view");

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
    // Same-host .vcf link. On the app host the whole page is a gated staff
    // preview that never counts; on the public host it is a real download.
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
