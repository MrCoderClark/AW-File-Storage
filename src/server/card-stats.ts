import { type CardMetric, orgDbFor } from "./org-db";

/**
 * Per-card engagement counting + reads for the public landing page (spec 0008).
 *
 * Counting is a daily rollup: one row per (file, day, metric), bumped with an
 * UPSERT on each counted public hit. It is deliberately best effort — the public
 * routes call `recordCardHit` after the response is sent, and it never throws, so
 * a D1 hiccup can lose a count but can never break a page load or a download
 * (AC-5). Reads aggregate the rollup on demand; there are no denormalised totals
 * to drift (spec 0008 decision).
 *
 * The org-scoped SQL lives in `orgDb().cardStats` (spec 0012); this module owns
 * only the aggregation/shaping into totals + series. It reaches the DB through
 * `orgDbFor`, never the raw client, so an org filter can't be forgotten.
 */

export type { CardMetric };

export interface CardStatsEnv {
  DB: D1Database;
}

/** Per-card totals across all time, plus the most recent activity day. */
export interface CardTotals {
  views: number;
  scans: number;
  downloads: number;
  /** Most recent activity day as "YYYY-MM-DD", or null if never touched. */
  lastActivity: string | null;
}

const ZERO: CardTotals = { views: 0, scans: 0, downloads: 0, lastActivity: null };

/**
 * User agents we never count (AC-4): search crawlers and the link-preview
 * fetchers that unfurl a URL pasted into chat/email. Matched case-insensitively
 * as substrings. Heuristic by nature — a determined client can spoof a browser —
 * but it removes the routine prefetch inflation that would otherwise swamp real
 * views.
 */
const BOT_UA = [
  "bot",
  "crawler",
  "spider",
  "slackbot",
  "slack-imgproxy",
  "facebookexternalhit",
  "facebot",
  "whatsapp",
  "twitterbot",
  "linkedinbot",
  "discordbot",
  "telegrambot",
  "applebot",
  "googlebot",
  "google-inspectiontool",
  "bingbot",
  "embedly",
  "quora link preview",
  "pinterest",
  "redditbot",
  "skypeuripreview",
  "vkshare",
  "w3c_validator",
  "curl/",
  "wget/",
  "python-requests",
  "headlesschrome",
  "preview",
];

/**
 * Whether a request with this user agent should increment a count. Known bots
 * and link-preview fetchers do not; an empty user agent still counts (rare, and
 * some privacy browsers strip it, so filtering it would drop real people).
 */
export function isCountableUserAgent(userAgent: string | null): boolean {
  if (!userAgent) return true;
  const ua = userAgent.toLowerCase();
  return !BOT_UA.some((needle) => ua.includes(needle));
}

/** Today's activity day as "YYYY-MM-DD" in UTC. */
function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Record one hit for a card. Best effort: never throws, so callers can fire it
 * without a try/catch and without awaiting on the response path (AC-5). Bumps
 * the (file, today, metric) counter by one with an atomic UPSERT, so concurrent
 * hits on the same card/day sum correctly (AC-3).
 */
export async function recordCardHit(
  env: CardStatsEnv,
  hit: { fileId: string; orgId: string; metric: CardMetric },
): Promise<void> {
  try {
    await orgDbFor(hit.orgId, env.DB).cardStats.recordHit(
      hit.fileId,
      utcDay(),
      hit.metric,
    );
  } catch {
    // Swallow: a lost count must never surface to the public request (AC-5).
  }
}

/**
 * Totals per file for a set of file ids, org-scoped, for the Files list (AC-7).
 * Returns a Map keyed by file id; ids with no activity are absent (callers treat
 * a miss as all-zero via `cardTotalsOrZero`). One grouped query over the whole
 * page's ids, so the list stays cheap at keyset-pagination size.
 */
export async function cardTotalsForFiles(
  env: CardStatsEnv,
  orgId: string,
  fileIds: string[],
): Promise<Map<string, CardTotals>> {
  const out = new Map<string, CardTotals>();
  if (fileIds.length === 0) return out;
  const rows = await orgDbFor(orgId, env.DB).cardStats.totalsForFiles(fileIds);

  for (const row of rows) {
    const t = out.get(row.fileId) ?? { ...ZERO };
    if (row.metric === "view") t.views = Number(row.total);
    else if (row.metric === "scan") t.scans = Number(row.total);
    else if (row.metric === "download") t.downloads = Number(row.total);
    if (!t.lastActivity || row.lastDate > t.lastActivity) t.lastActivity = row.lastDate;
    out.set(row.fileId, t);
  }
  return out;
}

/** A totals lookup that returns all-zero for a file with no recorded activity. */
export function cardTotalsOrZero(
  totals: Map<string, CardTotals>,
  fileId: string,
): CardTotals {
  return totals.get(fileId) ?? { ...ZERO };
}

export interface CardStatDetail {
  totals: CardTotals;
  /** Daily points (ascending by date) within the requested window. */
  series: { date: string; views: number; scans: number; downloads: number }[];
}

/**
 * Totals + a daily time series for one card (AC-7), org-scoped. `days` bounds the
 * series window (default 30); totals are all-time.
 */
export async function cardStatDetail(
  env: CardStatsEnv,
  orgId: string,
  fileId: string,
  days = 30,
): Promise<CardStatDetail> {
  const totalsMap = await cardTotalsForFiles(env, orgId, [fileId]);
  const totals = cardTotalsOrZero(totalsMap, fileId);

  const since = utcDay(new Date(Date.now() - days * 86400_000));
  const rows = await orgDbFor(orgId, env.DB).cardStats.detailRows(fileId, since);

  const byDate = new Map<
    string,
    { date: string; views: number; scans: number; downloads: number }
  >();
  for (const row of rows) {
    const point = byDate.get(row.date) ?? {
      date: row.date,
      views: 0,
      scans: 0,
      downloads: 0,
    };
    if (row.metric === "view") point.views = Number(row.total);
    else if (row.metric === "scan") point.scans = Number(row.total);
    else if (row.metric === "download") point.downloads = Number(row.total);
    byDate.set(row.date, point);
  }
  const series = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  return { totals, series };
}

export interface OrgEngagement {
  totals: CardTotals;
  /** Highest-engagement cards, most views first. */
  topCards: {
    fileId: string;
    name: string;
    slug: string | null;
    views: number;
    scans: number;
    downloads: number;
  }[];
  /** Org-wide daily points (ascending) within the window. */
  series: { date: string; views: number; scans: number; downloads: number }[];
}

/**
 * Org-level engagement for the Dashboard (AC-8): all-card totals, the top cards,
 * and a daily trend. When `uploaderUserId` is set (a member, who sees only their
 * own cards), results are restricted to cards that user uploaded by joining the
 * `file` table; owners/admins pass it undefined for the whole org.
 */
export async function orgEngagement(
  env: CardStatsEnv,
  orgId: string,
  opts: { days?: number; uploaderUserId?: string; topLimit?: number } = {},
): Promise<OrgEngagement> {
  const days = opts.days ?? 30;
  const topLimit = opts.topLimit ?? 5;
  const stats = orgDbFor(orgId, env.DB).cardStats;
  const since = utcDay(new Date(Date.now() - days * 86400_000));

  // Totals + trend: the helper joins `file` only when scoping to one uploader.
  const rows = await stats.engagementRows({
    since,
    uploaderUserId: opts.uploaderUserId,
  });

  const totals: CardTotals = { ...ZERO };
  const byDate = new Map<
    string,
    { date: string; views: number; scans: number; downloads: number }
  >();
  for (const row of rows) {
    const n = Number(row.total);
    if (row.metric === "view") totals.views += n;
    else if (row.metric === "scan") totals.scans += n;
    else if (row.metric === "download") totals.downloads += n;
    const point = byDate.get(row.date) ?? {
      date: row.date,
      views: 0,
      scans: 0,
      downloads: 0,
    };
    if (row.metric === "view") point.views += n;
    else if (row.metric === "scan") point.scans += n;
    else if (row.metric === "download") point.downloads += n;
    byDate.set(row.date, point);
    if (!totals.lastActivity || row.date > totals.lastActivity) {
      totals.lastActivity = row.date;
    }
  }
  const series = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  // Top cards: rank by total hits per file (within the window + scope), then read
  // each card's name/slug. A small join over the same filtered set.
  const topRows = await stats.topCards({
    since,
    uploaderUserId: opts.uploaderUserId,
    limit: topLimit,
  });

  const topCards = topRows.map((r) => ({
    fileId: r.fileId,
    name: r.name,
    slug: r.slug,
    views: Number(r.views),
    scans: Number(r.scans),
    downloads: Number(r.downloads),
  }));

  return { totals, topCards, series };
}
