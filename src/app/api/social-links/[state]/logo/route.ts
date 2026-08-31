import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requireApiRole } from "@/server/session";
import {
  clearStateLogo,
  type LogoUploadEnv,
  SocialLinkError,
  uploadStateLogo,
} from "@/server/social-links";

// Upload a per-state signature logo (owner/admin). Multipart form with a `logo`
// file; stored in the R2 public bucket, its URL saved on the state's row.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ state: string }> },
) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { state } = await params;

  const form = await req.formData().catch(() => null);
  const file = form?.get("logo");
  if (!(file instanceof File)) {
    return Response.json({ ok: false, error: "No file uploaded." }, { status: 400 });
  }

  const { env } = getCloudflareContext();
  try {
    const logoUrl = await uploadStateLogo(
      env as unknown as LogoUploadEnv,
      auth.actor.orgId,
      decodeURIComponent(state),
      await file.arrayBuffer(),
      file.type,
    );
    return Response.json({ ok: true, logoUrl });
  } catch (e) {
    if (e instanceof SocialLinkError) {
      return Response.json({ ok: false, error: e.message }, { status: e.status });
    }
    throw e;
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ state: string }> },
) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { state } = await params;
  const { env } = getCloudflareContext();
  await clearStateLogo(
    env as unknown as LogoUploadEnv,
    auth.actor.orgId,
    decodeURIComponent(state),
  );
  return Response.json({ ok: true });
}
