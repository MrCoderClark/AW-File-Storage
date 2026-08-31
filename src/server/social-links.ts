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

export interface SocialLinkRow {
  state: string;
  facebook: string | null;
  x: string | null;
  instagram: string | null;
  updatedAt: Date;
}

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
