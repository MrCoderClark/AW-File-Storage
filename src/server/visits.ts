import { inArray, lt } from "drizzle-orm";
import { buildDb } from "./db";
import { cardVisitEvent } from "./db/schema";
import { type CardMetric, orgDbFor } from "./org-db";

/**
 * Per-visitor engagement capture, read-time enrichment, and retention purge for
 * cards (spec 0030). A detail layer beside the daily rollup in card-stats.ts:
 * `recordCardVisit` writes one append-only row per counted public hit, capturing
 * who engaged (external IP + Cloudflare geo/network), on what device (the raw
 * User-Agent — device/OS/browser are DERIVED here at read time, never stored),
 * from where (referrer), and how (metric + src).
 *
 * The scoped record/read SQL lives in `orgDb().visits`; this module owns the
 * capture orchestration (hashing, cf mapping, the health signal), the read-time
 * User-Agent heuristic, and the ONE cross-org operation — the retention purge —
 * which by design spans every org and so uses the raw client (this module is on
 * the no-db-bypass allowlist for exactly that, like the other system jobs).
 */

export type { CardMetric };

export interface VisitEnv {
  DB: D1Database;
  /** Server secret salting `visitor_hash` (AC-5). Absent → the hash is unsalted. */
  IP_HASH_SALT?: string;
}

/** Geo/network subset of Cloudflare's request `cf` object we persist (AC-1). */
export interface CfGeo {
  country?: string;
  region?: string;
  city?: string;
  postalCode?: string;
  latitude?: string;
  longitude?: string;
  timezone?: string;
  asn?: number;
  asOrganization?: string;
}

/** Raw rows are kept 12 months, then purged (AC-9). Env-overridable per the config-over-hardcoded convention. */
const RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

// One-time health signal when Cloudflare's `cf` metadata is absent, so a silently
// broken geo path (all geo null) is caught early rather than months later. Module
// scope, so it fires at most once per Worker isolate (AC / config note in 0030).
let warnedCfMissing = false;
function warnCfMissingOnce() {
  if (warnedCfMissing) return;
  warnedCfMissing = true;
  console.warn(
    "[visits] Cloudflare request cf metadata unavailable — visitor geo/network " +
      "fields will be null; feed degrades to IP + country (spec 0030).",
  );
}

/** Today's activity day as "YYYY-MM-DD" in UTC (the hash's day bucket). */
function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Parse a numeric cf string (latitude/longitude come as strings) to a real, or null. */
function numeric(v: string | undefined | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Salted grouping key for the approximate unique-visitor count (AC-5):
 * `sha256(IP_HASH_SALT + ip + "|" + userAgent + "|" + utcDay)`. Null when there is
 * no IP (the key would be meaningless, and a null hash is excluded from the count).
 * Not a confidentiality measure — the raw `ip` is on the same row for admins — but
 * the salt keeps it from being rehashable against guessed IPs if `ip` is ever
 * redacted later.
 */
async function computeVisitorHash(
  salt: string | undefined,
  ip: string | null,
  userAgent: string | null,
  day: string,
): Promise<string | null> {
  if (!ip) return null;
  const input = `${salt ?? ""}${ip}|${userAgent ?? ""}|${day}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Record one visit event for a counted public hit (AC-1). Best effort: never
 * throws, so callers fire it on the same `waitUntil` as the rollup without a
 * try/catch and without awaiting on the response path (AC-3). The caller is
 * responsible for the countable-UA + public-host gate, so events and counts stay
 * in lockstep (AC-2, AC-4); this only writes the row.
 */
export async function recordCardVisit(
  env: VisitEnv,
  hit: {
    fileId: string;
    orgId: string;
    metric: CardMetric;
    ip: string | null;
    userAgent: string | null;
    referrer: string | null;
    src: string | null;
    /** `getCloudflareContext().cf` (undefined if unavailable → geo fields null). */
    cf: CfGeo | undefined;
    /** `CF-IPCountry` header, the always-present country fallback when cf is absent. */
    countryHeader: string | null;
  },
): Promise<void> {
  try {
    const cf = hit.cf;
    if (!cf) warnCfMissingOnce();
    const visitorHash = await computeVisitorHash(
      env.IP_HASH_SALT,
      hit.ip,
      hit.userAgent,
      utcDay(),
    );
    await orgDbFor(hit.orgId, env.DB).visits.record({
      fileId: hit.fileId,
      metric: hit.metric,
      ip: hit.ip,
      visitorHash,
      country: cf?.country ?? hit.countryHeader ?? null,
      region: cf?.region ?? null,
      city: cf?.city ?? null,
      postal: cf?.postalCode ?? null,
      latitude: numeric(cf?.latitude),
      longitude: numeric(cf?.longitude),
      timezone: cf?.timezone ?? null,
      asn: cf?.asn ?? null,
      asOrg: cf?.asOrganization ?? null,
      userAgent: hit.userAgent,
      referrer: hit.referrer,
      src: hit.src,
    });
  } catch {
    // Swallow: a lost visit event must never surface to the public request (AC-3).
  }
}

// --- Read-time device/OS/browser derivation from the stored User-Agent (AC-1). ---
// A lightweight in-house heuristic (the same style as the bot list), applied at
// render so an improved parser applies to old rows and no stale output is frozen in.

export interface VisitorDevice {
  browser: string;
  os: string;
  deviceType: "Mobile" | "Tablet" | "Desktop" | "Unknown";
}

/** Derive a coarse device/OS/browser from a raw User-Agent. Never throws. */
export function describeUserAgent(ua: string | null): VisitorDevice {
  if (!ua) return { browser: "Unknown", os: "Unknown", deviceType: "Unknown" };
  const s = ua.toLowerCase();

  // OS. Order matters: iPadOS/iOS before macOS; Android before Linux.
  let os = "Unknown";
  if (s.includes("windows")) os = "Windows";
  else if (s.includes("iphone") || s.includes("ipod")) os = "iOS";
  else if (s.includes("ipad")) os = "iPadOS";
  else if (s.includes("mac os x") || s.includes("macintosh")) os = "macOS";
  else if (s.includes("android")) os = "Android";
  else if (s.includes("cros")) os = "ChromeOS";
  else if (s.includes("linux")) os = "Linux";

  // Browser. Order matters: the more specific tokens (Edg, brand Chromium forks,
  // Chrome) before Safari, since they all carry "safari"/"chrome" in the UA.
  let browser = "Unknown";
  if (s.includes("edg/") || s.includes("edga/") || s.includes("edgios/"))
    browser = "Edge";
  else if (s.includes("opr/") || s.includes("opera")) browser = "Opera";
  else if (s.includes("samsungbrowser")) browser = "Samsung Internet";
  else if (s.includes("firefox") || s.includes("fxios")) browser = "Firefox";
  else if (s.includes("crios") || s.includes("chrome") || s.includes("chromium"))
    browser = "Chrome";
  else if (s.includes("safari")) browser = "Safari";

  // Device type.
  let deviceType: VisitorDevice["deviceType"] = "Desktop";
  if (s.includes("ipad") || (s.includes("android") && !s.includes("mobile")))
    deviceType = "Tablet";
  else if (
    s.includes("mobile") ||
    s.includes("iphone") ||
    s.includes("ipod") ||
    (s.includes("android") && s.includes("mobile"))
  )
    deviceType = "Mobile";
  if (os === "Unknown" && browser === "Unknown") deviceType = "Unknown";

  return { browser, os, deviceType };
}

/** A one-line label for the feed, e.g. "Chrome on Windows · Desktop". */
export function formatVisitorDevice(ua: string | null): string {
  const d = describeUserAgent(ua);
  if (d.browser === "Unknown" && d.os === "Unknown") return "Unknown device";
  const head =
    d.browser !== "Unknown" && d.os !== "Unknown"
      ? `${d.browser} on ${d.os}`
      : d.browser !== "Unknown"
        ? d.browser
        : d.os;
  return d.deviceType !== "Unknown" ? `${head} · ${d.deviceType}` : head;
}

/**
 * Retention purge (AC-9): delete `card_visit_event` rows older than 12 months,
 * across every org, in bounded batches. Cross-org by design — a system job, so it
 * uses the raw client (this module is on the no-db-bypass allowlist for this) and
 * never touches `card_stat_daily`. Deletes up to `maxBatches` batches of `batch`
 * rows per call and reports whether more remain, so the cron can self-chain if a
 * run is very large (like the spec 0028 drain).
 */
export async function purgeExpiredVisitEvents(
  env: VisitEnv,
  opts: { batch?: number; maxBatches?: number; retentionMs?: number } = {},
): Promise<{ deleted: number; more: boolean }> {
  const db = buildDb(env.DB);
  // Batch size doubles as the `IN (...)` parameter count on the delete, so keep it
  // well under D1's bound-variable limit (the bulk import chunks at 50 for the same
  // reason). 100 ids/batch × 20 batches = 2000 rows/call; the cron self-chains past.
  const batch = opts.batch ?? 100;
  const maxBatches = opts.maxBatches ?? 20;
  const cutoff = new Date(Date.now() - (opts.retentionMs ?? RETENTION_MS));

  let deleted = 0;
  let more = false;
  for (let i = 0; i < maxBatches; i++) {
    // D1/SQLite does not support LIMIT on DELETE, so select a bounded batch of ids
    // then delete by id — the (org, created_at) index keeps the scan cheap.
    const rows = await db
      .select({ id: cardVisitEvent.id })
      .from(cardVisitEvent)
      .where(lt(cardVisitEvent.createdAt, cutoff))
      .limit(batch);
    if (rows.length === 0) break;
    await db.delete(cardVisitEvent).where(
      inArray(
        cardVisitEvent.id,
        rows.map((r) => r.id),
      ),
    );
    deleted += rows.length;
    if (rows.length === batch && i === maxBatches - 1) more = true;
  }
  return { deleted, more };
}
