import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requireApiRole } from "@/server/session";
import {
  clearStateLogo,
  type LogoUploadEnv,
  reuseStateLogo,
  type SocialLinksEnv,
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

// Reuse an already-uploaded logo for this state (owner/admin). JSON `{ logoUrl }`
// where the URL is one the org already stores — points this state's row at the
// same object, no re-upload.
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ state: string }> },
) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { state } = await params;

  const body = (await req.json().catch(() => null)) as { logoUrl?: unknown } | null;
  const logoUrl = typeof body?.logoUrl === "string" ? body.logoUrl : "";

  const { env } = getCloudflareContext();
  try {
    await reuseStateLogo(
      env as unknown as SocialLinksEnv,
      auth.actor.orgId,
      decodeURIComponent(state),
      logoUrl,
    );
    return Response.json({ ok: true });
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
