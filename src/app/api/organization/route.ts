import { getCloudflareContext } from "@opennextjs/cloudflare";
import { eq } from "drizzle-orm";
import { buildDb } from "@/server/db";
import { member, organization } from "@/server/db/schema";
import { uuidv7 } from "@/server/id";
import { orgDbFor } from "@/server/org-db";
import { isPlatformOwner } from "@/server/platform";
import { r2Delete, type R2Config } from "@/server/r2";
import { getSession, requireApiRole } from "@/server/session";
import { publicKeyFor, type UploadEnv } from "@/server/uploads";

// Organization lifecycle (spec 0012).
//  GET    → the acting org's identity + storage, plus what the caller may do.
//  POST   → create a new organization (platform/app owner ONLY), caller = owner.
//  DELETE → delete the acting org (owner only, typed-name confirmation). Cascades
//           the DB (member/invitation + all tenant tables) and best-effort sweeps
//           the org's R2 objects.
export const dynamic = "force-dynamic";

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "org"
  );
}

function r2Config(env: UploadEnv): R2Config {
  return {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  };
}

/** The R2 object key from a stored logo URL ("logos/<org>/<STATE>.<ext>"). */
function keyFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname.replace(/^\/+/, "");
  } catch {
    return null;
  }
}

export async function GET() {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;
  const { env } = getCloudflareContext();
  const db = buildDb((env as unknown as UploadEnv).DB);
  const [org] = await db
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      storageUsedBytes: organization.storageUsedBytes,
      storageQuotaBytes: organization.storageQuotaBytes,
    })
    .from(organization)
    .where(eq(organization.id, auth.actor.orgId))
    .limit(1);
  if (!org) return Response.json({ ok: false }, { status: 404 });
  // The per-org bulk-import rate override (spec 0029); null means "use the env default".
  const { importRatePerHour } = await orgDbFor(
    auth.actor.orgId,
    (env as unknown as UploadEnv).DB,
  ).settings.get();
  return Response.json({
    ok: true,
    org,
    role: auth.actor.role,
    canDelete: auth.actor.role === "owner",
    canCreate: await isPlatformOwner(),
    importRatePerHour,
  });
}

// PATCH → per-org settings the owner/admin may change here. Currently just the
// bulk-import rate override (spec 0029): an integer 1..100 raises/lowers the cap
// for THIS org, and null clears it so the IMPORT_RATE_PER_HOUR env default applies
// again. Owner or admin (like every other org setting); the change is audited.
export async function PATCH(req: Request) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => ({}))) as {
    importRatePerHour?: number | null;
  };
  if (!("importRatePerHour" in body)) {
    return Response.json(
      { ok: false, error: "No setting to update." },
      { status: 400 },
    );
  }
  const raw = body.importRatePerHour;
  let next: number | null;
  if (raw === null) {
    next = null; // clear the override (AC-7)
  } else if (
    typeof raw === "number" &&
    Number.isInteger(raw) &&
    raw >= 1 &&
    raw <= 100
  ) {
    next = raw;
  } else {
    return Response.json(
      {
        ok: false,
        error: "Imports per hour must be a whole number from 1 to 100.",
      },
      { status: 400 },
    );
  }

  const { env } = getCloudflareContext();
  const scoped = orgDbFor(auth.actor.orgId, (env as unknown as UploadEnv).DB);
  const before = (await scoped.settings.get()).importRatePerHour;
  if (before !== next) {
    await scoped.settings.setImportRatePerHour(next);
    // One audit event per real change (AC-6), so loosening the abuse guard is
    // always attributable. from/to are what the Activity feed renders.
    await scoped.audit.append({
      actorUserId: auth.actor.userId,
      action: "import.rate_limit_changed",
      targetType: "org",
      targetId: auth.actor.orgId,
      metadataJson: JSON.stringify({ from: before, to: next }),
    });
  }
  return Response.json({ ok: true });
}

export async function POST(req: Request) {
  // Platform-owner tier only — above any org role (spec 0012).
  if (!(await isPlatformOwner())) {
    return Response.json(
      { ok: false, error: "Only the platform owner can create an organization." },
      { status: 403 },
    );
  }
  const session = await getSession();
  if (!session) return Response.json({ ok: false }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { name?: string };
  const name = body.name?.trim();
  if (!name) {
    return Response.json(
      { ok: false, error: "A name is required." },
      { status: 400 },
    );
  }

  const { env } = getCloudflareContext();
  const db = buildDb((env as unknown as UploadEnv).DB);

  // Unique slug: the base, else base-<short> if taken (organization.slug is unique).
  const base = slugify(name);
  let slug = base;
  const [clash] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.slug, base))
    .limit(1);
  if (clash) slug = `${base}-${uuidv7().slice(0, 8)}`;

  const orgId = uuidv7();
  const now = new Date();
  await db.insert(organization).values({ id: orgId, name, slug, createdAt: now });
  // The creating platform owner becomes the new org's owner.
  await db.insert(member).values({
    id: uuidv7(),
    organizationId: orgId,
    userId: session.user.id,
    role: "owner",
    createdAt: now,
  });

  return Response.json({ ok: true, orgId });
}

export async function DELETE(req: Request) {
  const auth = await requireApiRole("owner");
  if (!auth.ok) return auth.response;
  const orgId = auth.actor.orgId;

  const { env } = getCloudflareContext();
  const uploadEnv = env as unknown as UploadEnv;
  const db = buildDb(uploadEnv.DB);

  const [org] = await db
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1);
  if (!org) return Response.json({ ok: false }, { status: 404 });

  // Typed-name confirmation, re-checked on the server (never trust the client's
  // own gate). The exact org name must be echoed back.
  const body = (await req.json().catch(() => ({}))) as { confirmName?: string };
  if (body.confirmName !== org.name) {
    return Response.json(
      { ok: false, error: "The organization name did not match." },
      { status: 400 },
    );
  }

  // Best-effort R2 sweep of the org's known objects BEFORE the DB cascade removes
  // the rows that name them. Failures never block the deletion — orphaned objects
  // are unreachable once the rows are gone (the card route 404s) and only waste
  // storage. (Soft-deleted files' objects are reclaimed by the existing sweep.)
  const cfg = r2Config(uploadEnv);
  try {
    const scoped = orgDbFor(orgId, uploadEnv.DB);
    const files = await scoped.files.listActive();
    for (const f of files) {
      await r2Delete(cfg, uploadEnv.R2_PRIVATE_BUCKET, f.storageKey).catch(() => {});
      if (f.publicSlug) {
        await r2Delete(
          cfg,
          uploadEnv.R2_PUBLIC_BUCKET,
          publicKeyFor(f.publicSlug),
        ).catch(() => {});
      }
    }
    const logos = await scoped.socialLinks.list();
    for (const l of logos) {
      const key = keyFromUrl(l.logoUrl);
      if (key) {
        await r2Delete(cfg, uploadEnv.R2_PUBLIC_BUCKET, key).catch(() => {});
      }
    }
  } catch {
    // Sweep is best-effort; proceed to the DB deletion regardless.
  }

  // Delete the organization row: FK cascade removes member/invitation and every
  // tenant table (files, versions, uploads, audit, social links, card stats,
  // org settings). Cascades fire in D1 (see gotcha #9).
  await db.delete(organization).where(eq(organization.id, orgId));

  return Response.json({ ok: true });
}
