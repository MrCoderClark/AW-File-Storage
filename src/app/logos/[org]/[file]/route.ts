import { getCloudflareContext } from "@opennextjs/cloudflare";
import { r2GetBytes } from "@/server/r2";
import type { UploadEnv } from "@/server/uploads";

// Serve an admin-uploaded state logo from the R2 public bucket (spec 0008
// cutover). These live at `logos/<org>/<state>.<ext>` and are referenced by
// absolute URL (contacts.awvcard.com/logos/...) from card landing pages and
// email signatures. While contacts.awvcard.com pointed at the R2 bucket directly
// R2 served them; once the domain moves onto this Worker, the Worker must serve
// them or they'd 404. Two path segments (<org>/<file>) so this never shadows the
// built-in single-segment fallbacks in public/logos/ (e.g. /logos/ca.png).
export const dynamic = "force-dynamic";

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ org: string; file: string }> },
) {
  const { org, file } = await params;
  // Guard against path traversal / odd segments: both are single path segments,
  // so neither may be empty, "..", or contain a slash.
  for (const seg of [org, file]) {
    if (!seg || seg === "." || seg === ".." || seg.includes("/")) {
      return new Response("Not found", { status: 404 });
    }
  }

  const { env } = getCloudflareContext();
  const uploadEnv = env as unknown as UploadEnv;
  const cfg = {
    accountId: uploadEnv.R2_ACCOUNT_ID,
    accessKeyId: uploadEnv.R2_ACCESS_KEY_ID,
    secretAccessKey: uploadEnv.R2_SECRET_ACCESS_KEY,
  };

  const obj = await r2GetBytes(cfg, uploadEnv.R2_PUBLIC_BUCKET, `logos/${org}/${file}`);
  if (!obj) return new Response("Not found", { status: 404 });

  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  const contentType =
    obj.contentType ?? CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";

  return new Response(obj.body, {
    headers: {
      "Content-Type": contentType,
      // Logos are stable and cache-busted by a ?v= query on the stored URL.
      "Cache-Control": "public, max-age=3600",
      // The contacts host is noindex overall; keep image responses consistent.
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
