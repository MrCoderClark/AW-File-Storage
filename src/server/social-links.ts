import { and, eq, inArray } from "drizzle-orm";
import {
  AW_SIGNATURE_BRAND,
  normalizeState,
  type Socials,
  socialsForState,
} from "../lib/signature-brand";
import { buildDb } from "./db";
import { orgSocialLinks } from "./db/schema";
import { uuidv7 } from "./id";
import { r2Delete, r2Put, type R2Config } from "./r2";

/**
 * Per-state social links for printable signatures (spec 0009 follow-up). The
 * built-in values in `signature-brand.ts` are the fallback; rows here are the
 * admin-managed overrides/additions, resolved at signature time by the card's
 * state. `"*"` is the org-wide default (used when a card's state has no row).
 *
 * `org_social_link` is one of our own tables, but it's outside the `orgDb`
 * wrapper, so every query here writes its org filter explicitly.
 */

export interface SocialLinksEnv {
  DB: D1Database;
}

/** Extra env a logo upload needs (R2 public bucket writes). */
export interface LogoUploadEnv extends SocialLinksEnv {
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_PUBLIC_BUCKET: string;
  PUBLIC_FILE_DOMAIN?: string;
}

export interface SocialLinkRow {
  state: string;
  facebook: string | null;
  x: string | null;
  instagram: string | null;
  logoUrl: string | null;
  updatedAt: Date;
}

/** Allowed logo image types → file extension. */
const LOGO_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
};
const MAX_LOGO_BYTES = 1024 * 1024; // 1 MB

export class SocialLinkError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Trim to a non-empty string, or null. */
function clean(value: unknown): string | null {
  const s = typeof value === "string" ? value.trim() : "";
  return s === "" ? null : s;
}

/** Normalise a state key: `"*"` stays, otherwise a 2-letter abbreviation or "". */
function normKey(state: string): string {
  return state === "*" ? "*" : normalizeState(state);
}

export async function listSocialLinks(
  env: SocialLinksEnv,
  orgId: string,
): Promise<SocialLinkRow[]> {
  const db = buildDb(env.DB);
  return db
    .select({
      state: orgSocialLinks.state,
      facebook: orgSocialLinks.facebook,
      x: orgSocialLinks.x,
      instagram: orgSocialLinks.instagram,
      logoUrl: orgSocialLinks.logoUrl,
      updatedAt: orgSocialLinks.updatedAt,
    })
    .from(orgSocialLinks)
    .where(eq(orgSocialLinks.orgId, orgId))
    .orderBy(orgSocialLinks.state);
}

export async function upsertSocialLink(
  env: SocialLinksEnv,
  orgId: string,
  input: { state: string; facebook?: string; x?: string; instagram?: string },
): Promise<void> {
  const state = normKey(input.state ?? "");
  if (!state) {
    throw new SocialLinkError(400, "A valid US state is required.");
  }
  const facebook = clean(input.facebook);
  const x = clean(input.x);
  const instagram = clean(input.instagram);
  const db = buildDb(env.DB);
  const now = new Date();
  await db
    .insert(orgSocialLinks)
    .values({ id: uuidv7(), orgId, state, facebook, x, instagram, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [orgSocialLinks.orgId, orgSocialLinks.state],
      set: { facebook, x, instagram, updatedAt: now },
    });
}

export async function deleteSocialLink(
  env: SocialLinksEnv,
  orgId: string,
  state: string,
): Promise<void> {
  const key = normKey(state);
  if (!key) return;
  const db = buildDb(env.DB);
  await db
    .delete(orgSocialLinks)
    .where(and(eq(orgSocialLinks.orgId, orgId), eq(orgSocialLinks.state, key)));
}

/**
 * The socials to use for a card's state: an exact-state row wins, then the org's
 * `"*"` default row, then the built-in `signature-brand.ts` values. Null URLs on
 * a matched row simply hide that platform.
 */
export async function resolveSocials(
  env: SocialLinksEnv,
  orgId: string,
  cardState: string,
): Promise<Socials> {
  const abbr = normalizeState(cardState);
  const wanted = abbr ? [abbr, "*"] : ["*"];
  const db = buildDb(env.DB);
  const rows = await db
    .select()
    .from(orgSocialLinks)
    .where(and(eq(orgSocialLinks.orgId, orgId), inArray(orgSocialLinks.state, wanted)));
  const pick =
    (abbr && rows.find((r) => r.state === abbr)) || rows.find((r) => r.state === "*");
  if (pick) {
    return {
      facebook: pick.facebook ?? undefined,
      x: pick.x ?? undefined,
      instagram: pick.instagram ?? undefined,
    };
  }
  return socialsForState(AW_SIGNATURE_BRAND, cardState);
}

/**
 * The uploaded logo URL for a card's state (exact-state row → org "*" row →
 * null). Null means the caller should use the built-in `logosByState` fallback.
 */
export async function getStateLogoUrl(
  env: SocialLinksEnv,
  orgId: string,
  cardState: string,
): Promise<string | null> {
  const abbr = normalizeState(cardState);
  const wanted = abbr ? [abbr, "*"] : ["*"];
  const db = buildDb(env.DB);
  const rows = await db
    .select({ state: orgSocialLinks.state, logoUrl: orgSocialLinks.logoUrl })
    .from(orgSocialLinks)
    .where(
      and(eq(orgSocialLinks.orgId, orgId), inArray(orgSocialLinks.state, wanted)),
    );
  const pick =
    (abbr && rows.find((r) => r.state === abbr && r.logoUrl)?.logoUrl) ||
    rows.find((r) => r.state === "*" && r.logoUrl)?.logoUrl;
  return pick ?? null;
}

/** Upsert just the logo URL on a state's row (creates the row if needed). */
export async function setStateLogoUrl(
  env: SocialLinksEnv,
  orgId: string,
  state: string,
  logoUrl: string | null,
): Promise<void> {
  const key = normKey(state);
  if (!key) throw new SocialLinkError(400, "A valid state is required.");
  const db = buildDb(env.DB);
  const now = new Date();
  await db
    .insert(orgSocialLinks)
    .values({ id: uuidv7(), orgId, state: key, logoUrl, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [orgSocialLinks.orgId, orgSocialLinks.state],
      set: { logoUrl, updatedAt: now },
    });
}

/**
 * Point a state's row at a logo already uploaded for another state in this org —
 * no re-upload, no duplicate object; the two states share the one stored image.
 * The URL must be one this org already stores, so it can't be aimed at an
 * arbitrary address. Owner/admin only (enforced at the route).
 */
export async function reuseStateLogo(
  env: SocialLinksEnv,
  orgId: string,
  state: string,
  logoUrl: string,
): Promise<void> {
  const key = normKey(state);
  if (!key) throw new SocialLinkError(400, "A valid state is required.");
  const wanted = clean(logoUrl);
  if (!wanted) throw new SocialLinkError(400, "A logo is required.");
  const db = buildDb(env.DB);
  const owned = await db
    .select({ logoUrl: orgSocialLinks.logoUrl })
    .from(orgSocialLinks)
    .where(eq(orgSocialLinks.orgId, orgId));
  if (!owned.some((r) => r.logoUrl === wanted)) {
    throw new SocialLinkError(400, "That logo isn't one of your uploaded logos.");
  }
  await setStateLogoUrl(env, orgId, key, wanted);
}

function r2Config(env: LogoUploadEnv): R2Config {
  return {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  };
}

/**
 * Store an uploaded logo in the R2 public bucket and record its URL on the
 * state's row. Validates type + size; returns a cache-busted public URL so a
 * replacement is picked up. Owner/admin only (enforced at the route).
 */
export async function uploadStateLogo(
  env: LogoUploadEnv,
  orgId: string,
  state: string,
  bytes: ArrayBuffer,
  contentType: string,
): Promise<string> {
  const key = normKey(state);
  if (!key) throw new SocialLinkError(400, "A valid state is required.");
  const ext = LOGO_TYPES[contentType];
  if (!ext) throw new SocialLinkError(415, "Logo must be a PNG or JPEG image.");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_LOGO_BYTES) {
    throw new SocialLinkError(413, "Logo must be between 1 byte and 1 MB.");
  }

  const cfg = r2Config(env);
  const db = buildDb(env.DB);
  // The state's current logo, read before we overwrite the row, so an extension
  // change (e.g. .jpg -> .png) can clean up the now-orphaned old object.
  const [prev] = await db
    .select({ logoUrl: orgSocialLinks.logoUrl })
    .from(orgSocialLinks)
    .where(and(eq(orgSocialLinks.orgId, orgId), eq(orgSocialLinks.state, key)));

  const objectKey = `logos/${orgId}/${key}.${ext}`;
  await r2Put(cfg, env.R2_PUBLIC_BUCKET, objectKey, bytes, {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=300",
  });
  const domain = env.PUBLIC_FILE_DOMAIN ?? "contacts.awvcard.com";
  const logoUrl = `https://${domain}/${objectKey}?v=${Date.now()}`;
  await setStateLogoUrl(env, orgId, key, logoUrl);

  // If the previous object was at a different key (the file type changed) and no
  // other state reuses it, delete it so R2 keeps no stale logo. Guarded like
  // clearStateLogo; the row now points at the new URL, so it can't self-match.
  const prevPath = objectPathFromUrl(prev?.logoUrl ?? null);
  if (prevPath && prevPath !== objectKey) {
    const rows = await db
      .select({ logoUrl: orgSocialLinks.logoUrl })
      .from(orgSocialLinks)
      .where(eq(orgSocialLinks.orgId, orgId));
    const stillUsed = rows.some((r) => r.logoUrl?.includes(prevPath));
    if (!stillUsed) {
      await r2Delete(cfg, env.R2_PUBLIC_BUCKET, prevPath).catch(() => {});
    }
  }
  return logoUrl;
}

/** The R2 object key ("logos/<org>/<STATE>.<ext>") from a stored logo URL. */
function objectPathFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname.replace(/^\/+/, "");
  } catch {
    return null;
  }
}

/**
 * Detach a state's logo: clear its URL, and delete the stored object only if no
 * other state is reusing it (a shared image stays until its last user drops it).
 */
export async function clearStateLogo(
  env: LogoUploadEnv,
  orgId: string,
  state: string,
): Promise<void> {
  const key = normKey(state);
  if (!key) return;
  const db = buildDb(env.DB);
  const rows = await db
    .select({ state: orgSocialLinks.state, logoUrl: orgSocialLinks.logoUrl })
    .from(orgSocialLinks)
    .where(eq(orgSocialLinks.orgId, orgId));
  const cfg = r2Config(env);
  for (const ext of Object.values(LOGO_TYPES)) {
    const objectPath = `logos/${orgId}/${key}.${ext}`;
    const stillUsed = rows.some(
      (r) => r.state !== key && r.logoUrl?.includes(objectPath),
    );
    if (!stillUsed) {
      await r2Delete(cfg, env.R2_PUBLIC_BUCKET, objectPath).catch(() => {});
    }
  }
  await setStateLogoUrl(env, orgId, key, null);
}

/**
 * Copy the built-in defaults (`socials` as `"*"`, plus each `socialsByState`
 * entry) into this org's rows so an admin can see and edit them. Skips states
 * that already have a row. Returns how many were inserted.
 */
export async function seedDefaultsFromBrand(
  env: SocialLinksEnv,
  orgId: string,
): Promise<number> {
  const db = buildDb(env.DB);
  const existing = await db
    .select({ state: orgSocialLinks.state })
    .from(orgSocialLinks)
    .where(eq(orgSocialLinks.orgId, orgId));
  const have = new Set(existing.map((r) => r.state));

  const seeds: { state: string; socials: Socials }[] = [
    { state: "*", socials: AW_SIGNATURE_BRAND.socials },
    ...Object.entries(AW_SIGNATURE_BRAND.socialsByState).map(([state, socials]) => ({
      state,
      socials,
    })),
  ];

  const now = new Date();
  let inserted = 0;
  for (const seed of seeds) {
    if (have.has(seed.state)) continue;
    await db.insert(orgSocialLinks).values({
      id: uuidv7(),
      orgId,
      state: seed.state,
      facebook: seed.socials.facebook ?? null,
      x: seed.socials.x ?? null,
      instagram: seed.socials.instagram ?? null,
      createdAt: now,
      updatedAt: now,
    });
    inserted++;
  }
  return inserted;
}
