import { getCloudflareContext } from "@opennextjs/cloudflare";
import QRCode from "qrcode";
import { resolvePublishedCardUrl } from "@/server/signature";
import type { UploadEnv } from "@/server/uploads";

// Hosted QR image for a published card's public URL (spec 0009). PUBLIC on
// purpose: an email recipient's client fetches it with no session cookie, and it
// only ever encodes the already-public vCard address, so there's nothing to
// gate. Returns 404 for anything that isn't a live, published card.
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { env } = getCloudflareContext();
  const url = await resolvePublishedCardUrl(env as unknown as UploadEnv, id);
  if (!url) return new Response("Not found", { status: 404 });

  const cache = "public, max-age=3600";
  // PNG renders reliably in every email client; if the runtime can't produce one
  // (pngjs/zlib), degrade to SVG, which qrcode builds in pure JS.
  try {
    const dataUrl = await QRCode.toDataURL(url, {
      width: 320,
      margin: 1,
      errorCorrectionLevel: "M",
    });
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
    return new Response(bytes, {
      headers: { "Content-Type": "image/png", "Cache-Control": cache },
    });
  } catch {
    const svg = await QRCode.toString(url, {
      type: "svg",
      margin: 1,
      errorCorrectionLevel: "M",
    });
    return new Response(svg, {
      headers: { "Content-Type": "image/svg+xml", "Cache-Control": cache },
    });
  }
}
