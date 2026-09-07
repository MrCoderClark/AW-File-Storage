import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAppSettings } from "@/server/app-settings";
import { buildCardLandingHtml } from "@/lib/card-landing-html";
import { buildCardPdf } from "@/lib/card-pdf";
import { AW_SIGNATURE_BRAND, logoForState } from "@/lib/signature-brand";
import {
  isCountableUserAgent,
  recordCardHit,
  type CardMetric,
} from "@/server/card-stats";
import { r2GetBytes, r2GetText } from "@/server/r2";
import { getSession } from "@/server/session";
import { resolveCardBySlug } from "@/server/signature";
import { getStateLogoUrl, resolveSocials } from "@/server/social-links";
import { publicKeyFor, type UploadEnv } from "@/server/uploads";
import { parseVcard } from "@/server/vcard";

// Serving for a published contact card, split by request host (spec 0009).
// ONE GET handler for three shapes under /c/:
//   /c/<slug>       → the styled HTML landing page (a scan when ?src=qr).
//   /c/<slug>.vcf   → the vCard bytes, byte-and-type identical to what R2 served.
//   /c/<slug>.pdf   → the same card as a one-page PDF to print or keep.
//
// The .pdf is generated on the fly from the SAME published `.vcf` in R2, so it
// can never drift from the card or the landing page. It counts under its own
// `pdf` metric rather than being folded into `download` (the `.vcf`), so neither
// number changes meaning.
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
const NOSNIFF = "nosniff";

// The landing page ships ZERO JavaScript and only loads same-host images + inline
// styles, so it enforces a strict, script-free CSP (spec 0020) — a hard second
// backstop against any stored-XSS attempt in a card's own contact data. next.config
// sets no *enforced* Content-Security-Policy, so this handler-set one is authoritative.
//
// Images come from the app host ('self': the QR endpoint, social icons, built-in
// logos) or from the public file domain (an org's uploaded state logo is stored
// there — a cross-host reference when the page is previewed on the app host), so both
// are allowed for `img-src`. Everything else stays denied; there is no `script-src`.
function landingCsp(publicDomain: string): string {
  return [
    "default-src 'none'",
    `img-src 'self' https://${publicDomain} data:`,
    "style-src 'unsafe-inline'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join("; ");
}

/**
 * Logo bytes for the PDF header, resolved the same way the landing page resolves
 * its `<img src>`: the org's uploaded per-state logo first, else the built-in
 * state logo.
 *
 * Neither branch may fetch a page URL. An uploaded logo's URL points at THIS
 * Worker's own /logos/<org>/<file> route on the same hostname, and a Worker
 * calling its own hostname does not work in production (it silently failed, so
 * every live PDF fell back to the text header). Instead:
 *   uploaded  → read the object straight out of the public R2 bucket, which is
 *               exactly what the /logos route does, minus the round trip.
 *   built-in  → read it from the ASSETS binding, not over HTTP.
 *
 * Returns null on any failure: a missing logo must never fail the download.
 */
async function loadLogoBytes(
  env: UploadEnv,
  url: URL,
  uploadedLogo: string | null,
  logoPath: string,
): Promise<Uint8Array | null> {
  try {
    if (uploadedLogo) {
      // The stored URL is `<host>/logos/<org>/<state>.<ext>?v=<cachebust>`, and
      // the R2 key is that path without the leading slash or the query.
      const key = new URL(uploadedLogo, url.origin).pathname.replace(/^\/+/, "");
      if (!key.startsWith("logos/")) return null;
      const obj = await r2GetBytes(
        {
          accountId: env.R2_ACCOUNT_ID,
          accessKeyId: env.R2_ACCESS_KEY_ID,
          secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        },
        env.R2_PUBLIC_BUCKET,
        key,
      );
      return obj ? new Uint8Array(obj.body) : null;
    }

    const assets = (env as unknown as { ASSETS?: Fetcher }).ASSETS;
    const target = new URL(logoPath, url.origin).toString();
    const res = assets ? await assets.fetch(target) : await fetch(target);
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

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

  const lowerSlug = rawSlug.toLowerCase();
  const isDownload = lowerSlug.endsWith(".vcf");
  const isPdf = lowerSlug.endsWith(".pdf");
  const slug = isDownload || isPdf ? rawSlug.slice(0, -4) : rawSlug;

  const ref = await resolveCardBySlug(env, slug);
  if (!ref) {
    // Unknown or unpublished slug: 404, no count (AC-6).
    return new Response("Not found", {
      status: 404,
      headers: {
        "X-Robots-Tag": NOINDEX,
        "Cache-Control": NO_CACHE,
        "X-Content-Type-Options": NOSNIFF,
      },
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
      headers: {
        "X-Robots-Tag": NOINDEX,
        "Cache-Control": NO_CACHE,
        "X-Content-Type-Options": NOSNIFF,
      },
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
        "X-Content-Type-Options": NOSNIFF,
      },
    });
  }

  const baseUrl = url.origin;

  // The PDF is its own metric, and this branch sits ABOVE the view/scan counting
  // on purpose: a .pdf request is a save, not a page view, so it must not record
  // both. Like every other metric it only counts on the public host, so a
  // signed-in member saving a PDF from www never moves the number.
  if (isPdf) {
    count("pdf");
    const card = parseVcard(raw);
    const state = card.address.state;
    const uploadedLogo = await getStateLogoUrl(env, ref.orgId, state);
    const pdf = await buildCardPdf({
      card,
      brand: AW_SIGNATURE_BRAND,
      canonicalUrl: `${baseUrl}/c/${slug}`,
      logoImage: await loadLogoBytes(
        env,
        url,
        uploadedLogo,
        logoForState(AW_SIGNATURE_BRAND, state),
      ),
    });
    return new Response(pdf as BodyInit, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${slug}.pdf"`,
        "Cache-Control": NO_CACHE,
        "X-Robots-Tag": NOINDEX,
        "X-Content-Type-Options": NOSNIFF,
      },
    });
  }

  // Landing page: a QR-sourced load is a scan, otherwise a plain view.
  const isScan = url.searchParams.get("src") === "qr";
  count(isScan ? "scan" : "view");

  const card = parseVcard(raw);
  const state = card.address.state;
  // Prefer the org's admin-assigned per-state logo (same as the signature); fall
  // back to the built-in state logo when none is uploaded.
  const uploadedLogo = await getStateLogoUrl(env, ref.orgId, state);
  const logoUrl = uploadedLogo ?? `${baseUrl}${logoForState(AW_SIGNATURE_BRAND, state)}`;

  const socials = await resolveSocials(env, ref.orgId, state);
  const html = buildCardLandingHtml({
    card,
    // Same-host .vcf link. On the app host the whole page is a gated staff
    // preview that never counts; on the public host it is a real download.
    vcfUrl: `${baseUrl}/c/${slug}.vcf`,
    qrUrl: `${baseUrl}/api/cards/${ref.fileId}/qr`,
    logoUrl,
    baseUrl,
    canonicalUrl: `${baseUrl}/c/${slug}`,
    pdfUrl: `${baseUrl}/c/${slug}.pdf`,
    socials,
    brand: AW_SIGNATURE_BRAND,
  });

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": NO_CACHE,
      "X-Robots-Tag": NOINDEX,
      "X-Content-Type-Options": NOSNIFF,
      "Content-Security-Policy": landingCsp(publicDomain),
    },
  });
}
