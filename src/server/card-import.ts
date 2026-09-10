import { getCloudflareContext } from "@opennextjs/cloudflare";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { buildVcard, type CardFields } from "../lib/vcard-builder";
import { buildDb } from "./db";
import { cardImportRows, cardImports } from "./db/schema";
import { orgDb, type OrgDb } from "./org-db";
import {
  publishVcardFromBytes,
  UploadError,
  type UploadEnv,
} from "./uploads";
import { validateVcard } from "./vcard";

// Bulk contact-card import (spec 0028). The browser parses the spreadsheet, maps the
// columns, and previews entirely client-side, then POSTs the already-mapped rows as
// JSON (never the raw file). This module is the SERVER half: it re-validates every row
// (the browser preview is a courtesy, not a source of truth), stores the run and its
// rows, and — on the companion cron drain — publishes each valid row through the
// existing `publishVcardFromBytes` pipeline in bounded, resumable batches.

// --- Configuration (spec 0028; env-overridable, see [[config-over-hardcoded]]). ---
const DEFAULT_MAX_IMPORT_ROWS = 250; // per-import row cap (AC-9)
const DEFAULT_IMPORT_RATE_PER_HOUR = 5; // accepted submissions per user per hour (AC-9)
const DEFAULT_DRAIN_BATCH = 20; // rows published per drain tick (AC-6)
const DEFAULT_MAX_ATTEMPTS = 3; // drain attempts before a row is failed (AC-13)
// A `processing` row whose claim is older than this is presumed abandoned (a crashed
// drain) and reclaimed by the next tick (AC-13).
const RECLAIM_MS = 5 * 60 * 1000;

const ONE_HOUR_MS = 60 * 60 * 1000;

const TERMINAL_STATUSES = new Set([
  "completed",
  "completed_with_errors",
  "failed",
]);

/** The config vars this feature reads, all optional (code defaults apply). */
export interface CardImportEnv extends UploadEnv {
  MAX_IMPORT_ROWS?: string;
  IMPORT_RATE_PER_HOUR?: string;
  CARD_IMPORT_DRAIN_BATCH?: string;
  CARD_IMPORT_MAX_ATTEMPTS?: string;
  // Used to self-kick the drain on demand (no periodic cron): the submit request and
  // each drain tick fire a background POST to `${APP_URL}/api/cron/card-import` with the
  // bearer secret. Absent locally -> the kick is skipped (the drain still runs via a
  // manual call or the nightly safety-net).
  APP_URL?: string;
  CRON_SECRET?: string;
}

// How many batches one invocation drains before handing off. Publishing a row makes
// several subrequests (2 R2 puts + a handful of D1 writes), and a Worker invocation has
// a per-invocation subrequest budget, so one background run does a bounded number of
// batches (~3 × CARD_IMPORT_DRAIN_BATCH rows) and then continues in a fresh invocation.
const MAX_BATCHES_PER_RUN = 3;

/**
 * Drain up to MAX_BATCHES_PER_RUN batches IN-PROCESS (no HTTP), staying within one
 * invocation's limits. Returns the aggregate counts plus `more`: true when the run hit
 * its batch cap with rows still flowing (so a continuation is needed), false when a
 * batch drained nothing (the queue is empty).
 */
export async function runDrainRun(
  env: CardImportEnv,
): Promise<DrainResult & { more: boolean }> {
  let drained = 0;
  let published = 0;
  let skipped = 0;
  let failed = 0;
  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    const r = await drainCardImports(env);
    drained += r.drained;
    published += r.published;
    skipped += r.skipped;
    failed += r.failed;
    if (r.drained === 0) {
      return { drained, published, skipped, failed, more: false };
    }
  }
  return { drained, published, skipped, failed, more: true };
}

/**
 * Kick the drain the moment an import is submitted (spec 0028, on-demand model). Runs the
 * work IN-PROCESS on `ctx.waitUntil` (the same proven pattern as `triggerO365Sync`), so
 * it needs no self-fetch and no APP_URL/CRON_SECRET — a small import publishes right
 * here in the background. Only if the run hits its batch cap (a large import) does it
 * hand off to a fresh invocation via `continueDrainViaFetch`. Never throws.
 */
export function kickDrain(env: CardImportEnv): void {
  const p = (async () => {
    const r = await runDrainRun(env);
    if (r.more) await continueDrainViaFetch(env);
  })().catch(() => {});
  try {
    getCloudflareContext().ctx.waitUntil(p);
  } catch {
    // No request context (e.g. a test) — the promise still runs on its own.
  }
}

/**
 * Hand a large import off to a fresh invocation (fresh subrequest budget) by POSTing the
 * drain endpoint. Best-effort only: it is used solely to continue an import past one
 * run's batch cap, and if it can't run (a Worker calling its own route can be blocked on
 * some setups) the nightly safety-net cron finishes the rest. A no-op without
 * APP_URL / CRON_SECRET.
 */
export async function continueDrainViaFetch(env: CardImportEnv): Promise<void> {
  const appUrl = env.APP_URL;
  const secret = env.CRON_SECRET;
  if (!appUrl || !secret) return;
  try {
    await fetch(`${appUrl}/api/cron/card-import`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        // The app's proxy.ts CSRF guard wants a same-host Origin (known issue).
        Origin: appUrl,
      },
    });
  } catch {
    // Ignored — the nightly safety-net drain will finish any remaining rows.
  }
}

function cfgInt(raw: string | number | undefined, fallback: number): number {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Bound n to [lo, hi] (spec 0029 effective-limit safety clamp). */
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/**
 * One mapped contact from the browser — the card field set, NOT raw spreadsheet cells.
 * `rowNumber` is the source spreadsheet row, echoed back in the report; it is advisory
 * (the server guarantees a unique row number per import regardless of what arrives).
 */
export interface MappedRow {
  rowNumber?: number;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  jobTitle?: string;
  organization?: string;
  department?: string;
  email?: string;
  workPhone?: string;
  mobilePhone?: string;
  fax?: string;
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  website?: string;
}

const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Coerce a loose mapped row into the strict CardFields the vCard builder expects. */
export function toCardFields(row: MappedRow): CardFields {
  return {
    firstName: s(row.firstName),
    lastName: s(row.lastName),
    fullName: s(row.fullName) || undefined,
    email: s(row.email),
    mobilePhone: s(row.mobilePhone) || undefined,
    workPhone: s(row.workPhone) || undefined,
    fax: s(row.fax) || undefined,
    organization: s(row.organization) || undefined,
    department: s(row.department) || undefined,
    jobTitle: s(row.jobTitle) || undefined,
    street: s(row.street) || undefined,
    city: s(row.city) || undefined,
    state: s(row.state) || undefined,
    zip: s(row.zip) || undefined,
    country: s(row.country) || undefined,
    website: s(row.website) || undefined,
  };
}

export type ValidatedRow =
  | { ok: true; contactName: string; fields: CardFields }
  | { ok: false; contactName: string | null; reason: string };

/**
 * Server-side validation of one mapped row (spec 0028 AC-5/AC-8). A row must yield a
 * usable name and a vCard that passes the SAME `validateVcard` gate as every other
 * published card. A row that can't is reported failed with a readable reason; the
 * valid rows in the same import still publish (partial success).
 */
export function validateRow(row: MappedRow): ValidatedRow {
  const fields = toCardFields(row);
  const fullName = (
    fields.fullName || `${fields.firstName} ${fields.lastName}`
  ).trim();
  if (!fullName) {
    return {
      ok: false,
      contactName: null,
      reason: "This row has no name, so it can't become a contact card.",
    };
  }
  const result = validateVcard(buildVcard(fields));
  if (!result.ok) {
    return { ok: false, contactName: fullName, reason: result.reason };
  }
  return { ok: true, contactName: fullName, fields };
}

/** Raised by createCardImport for the HTTP-mappable refusals (413 cap, 429 rate, 409 id). */
export class ImportError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ImportError";
  }
}

export interface SubmitResult {
  importId: string;
  status: string;
  total: number;
  idempotent: boolean;
}

function isUniqueViolation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /unique constraint failed/i.test(msg);
}

/**
 * Accept a bulk import (spec 0028). Order matters for the acceptance criteria:
 *   1. AC-11 idempotency — a repeat of the same client import id returns the existing
 *      import, never a second record (and never counts against the rate limit).
 *   2. AC-9 row cap — an over-cap sheet is refused before any record is created, and
 *      before the rate-limit count, so the refusal is free.
 *   3. AC-9 rate limit — accepted submissions per user per hour.
 *   4. AC-5/AC-8 validation — every row is validated; valid rows are stored `pending`
 *      for the drain, invalid rows stored already-`failed` with a reason.
 * Writes a start (and, if the import is already terminal, a finish) audit event (AC-10).
 */
export async function createCardImport(
  env: CardImportEnv,
  orgId: string,
  actorUserId: string,
  importId: string,
  rows: MappedRow[],
): Promise<SubmitResult> {
  const db = buildDb(env.DB);
  const scoped = orgDb(orgId, db);

  const existing = await scoped.cardImports.get(importId);
  if (existing) {
    return {
      importId,
      status: existing.status,
      total: existing.totalRows,
      idempotent: true,
    };
  }

  const max = cfgInt(env.MAX_IMPORT_ROWS, DEFAULT_MAX_IMPORT_ROWS);
  if (rows.length === 0) {
    throw new ImportError(400, "The file has no rows to import.");
  }
  if (rows.length > max) {
    throw new ImportError(
      413,
      `An import is limited to ${max} rows, but this file has ${rows.length}.`,
    );
  }

  // Effective limit (spec 0029): the org's configured value overrides the env
  // default, clamped to 1..100. A non-null org value is already validated on write;
  // the clamp is a belt-and-braces guard for a stale or unexpected stored value.
  const { importRatePerHour: orgLimit } = await scoped.settings.get();
  const envLimit = cfgInt(env.IMPORT_RATE_PER_HOUR, DEFAULT_IMPORT_RATE_PER_HOUR);
  const perHour = clamp(orgLimit ?? envLimit, 1, 100);
  // Counting floor (spec 0029): the later of one hour ago and this user's most recent
  // `import.rate_reset` event, so an admin reset moves the window forward without
  // deleting any prior import (AC-3/AC-4). No reset -> the plain one-hour window.
  const resetAt = await scoped.audit.latestActionAt(
    "import.rate_reset",
    actorUserId,
  );
  const floorMs = Math.max(
    Date.now() - ONE_HOUR_MS,
    resetAt ? resetAt.getTime() : 0,
  );
  const recent = await scoped.cardImports.countRecentByActor(
    actorUserId,
    floorMs,
  );
  if (recent >= perHour) {
    throw new ImportError(
      429,
      "You've started several imports recently. Please try again in a little while.",
    );
  }

  // Assign a unique row number per import (the client's number when usable, else the
  // next free integer) so the (import_id, row_number) unique index never rejects a batch.
  const used = new Set<number>();
  let nextAuto = 1;
  const assignRowNumber = (raw: number | undefined): number => {
    let n = typeof raw === "number" ? raw : Number.NaN;
    if (!Number.isInteger(n) || n <= 0 || used.has(n)) {
      while (used.has(nextAuto)) nextAuto++;
      n = nextAuto;
    }
    used.add(n);
    return n;
  };

  const rowRecords: {
    importId: string;
    rowNumber: number;
    contactName: string | null;
    payloadJson: string;
    outcome: "pending" | "failed";
    reason?: string;
  }[] = [];
  let failedAtSubmit = 0;
  for (const row of rows) {
    const rowNumber = assignRowNumber(row.rowNumber);
    const v = validateRow(row);
    if (v.ok) {
      rowRecords.push({
        importId,
        rowNumber,
        contactName: v.contactName,
        payloadJson: JSON.stringify(v.fields),
        outcome: "pending",
      });
    } else {
      failedAtSubmit++;
      rowRecords.push({
        importId,
        rowNumber,
        contactName: v.contactName,
        payloadJson: JSON.stringify(toCardFields(row)),
        outcome: "failed",
        reason: v.reason,
      });
    }
  }

  const hasPending = failedAtSubmit < rows.length;
  const counts = { published: 0, skipped: 0, failed: failedAtSubmit };
  const status = hasPending ? "pending" : settleStatus(counts);
  const now = new Date();

  try {
    await scoped.cardImports.create({
      id: importId,
      actorUserId,
      status,
      totalRows: rows.length,
      publishedCount: 0,
      skippedCount: 0,
      failedCount: failedAtSubmit,
      completedAt: hasPending ? null : now,
    });
  } catch (e) {
    // A concurrent identical submit (or a reused id) collided on the primary key. If the
    // colliding import is ours, treat it as the same import (idempotent, AC-11); if it
    // belongs to another org, it is a genuine id clash.
    if (isUniqueViolation(e)) {
      const again = await scoped.cardImports.get(importId);
      if (again) {
        return {
          importId,
          status: again.status,
          total: again.totalRows,
          idempotent: true,
        };
      }
      throw new ImportError(409, "That import id is already in use.");
    }
    throw e;
  }

  await scoped.cardImports.createRows(rowRecords);

  await scoped.audit.append({
    actorUserId,
    action: "card.import_started",
    targetType: "card_import",
    targetId: importId,
    metadataJson: JSON.stringify({
      total: rows.length,
      failedAtSubmit,
    }),
  });
  // An import with no publishable rows is already terminal at submit — write its finish
  // event now so the "one start, one finish" invariant (AC-10) holds without a drain.
  if (!hasPending) {
    await appendFinishAudit(scoped, importId, actorUserId, counts);
  }

  return { importId, status, total: rows.length, idempotent: false };
}

export interface DrainResult {
  drained: number;
  published: number;
  skipped: number;
  failed: number;
}

/**
 * Publish a bounded batch of pending import rows (spec 0028 AC-6/AC-13). Registered on
 * the companion cron Worker alongside the O365 jobs. A cross-org SYSTEM job: the ONE
 * discovery read spans every org (like the O365 provision / cleanup sweeps), but every
 * write is confined to the row's own org through `orgDb`. Safe to run concurrently and
 * to re-run: each row is claimed atomically, a terminal row is never touched again, and
 * the (import_id, row_number) key plus the per-org card uniqueness mean no row is ever
 * published twice.
 */
export async function drainCardImports(
  env: CardImportEnv,
): Promise<DrainResult> {
  const db = buildDb(env.DB);
  const batch = cfgInt(env.CARD_IMPORT_DRAIN_BATCH, DEFAULT_DRAIN_BATCH);
  const maxAttempts = cfgInt(env.CARD_IMPORT_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS);
  const staleBefore = new Date(Date.now() - RECLAIM_MS);

  const candidates = await db
    .select({
      id: cardImportRows.id,
      orgId: cardImportRows.orgId,
      importId: cardImportRows.importId,
      payloadJson: cardImportRows.payloadJson,
      actorUserId: cardImports.actorUserId,
    })
    .from(cardImportRows)
    .innerJoin(cardImports, eq(cardImports.id, cardImportRows.importId))
    .where(
      or(
        eq(cardImportRows.outcome, "pending"),
        and(
          eq(cardImportRows.outcome, "processing"),
          or(
            isNull(cardImportRows.claimedAt),
            lt(cardImportRows.claimedAt, staleBefore),
          ),
        ),
      ),
    )
    .orderBy(cardImportRows.createdAt)
    .limit(batch);

  const touched = new Map<string, string>(); // importId -> orgId
  let drained = 0;
  let published = 0;
  let skipped = 0;
  let failed = 0;

  for (const c of candidates) {
    const scoped = orgDb(c.orgId, db);
    const claimed = await scoped.cardImports.claimRow(c.id, staleBefore);
    if (!claimed) continue; // a concurrent drain claimed it first
    drained++;
    touched.set(c.importId, c.orgId);

    // Bounded retry (AC-13): a row that has burned through its attempts is failed, not
    // retried forever. `attempts` was just incremented by the claim.
    if (claimed.attempts > maxAttempts) {
      await scoped.cardImports.setRowOutcome(c.id, {
        outcome: "failed",
        reason: "Publishing failed repeatedly; giving up.",
      });
      failed++;
      continue;
    }

    try {
      const fields = JSON.parse(c.payloadJson) as CardFields;
      const res = await publishVcardFromBytes(env, c.orgId, buildVcard(fields), {
        uploadedBy: c.actorUserId,
        source: "import",
        // Imports dedupe within the org by the name-derived slug and never trigger the
        // O365 sync — publishVcardFromBytes writes only the card + its audit (AC-7, AC-12).
        skipSameOrgSlugDuplicate: true,
      });
      if (res.created) {
        await scoped.cardImports.setRowOutcome(c.id, {
          outcome: "published",
          fileId: res.fileId ?? null,
          reason: null,
        });
        published++;
      } else {
        await scoped.cardImports.setRowOutcome(c.id, {
          outcome: "skipped",
          fileId: res.fileId ?? null,
          reason:
            res.duplicate === "same_org_slug"
              ? "A card for this person already exists in your organization."
              : "An identical card is already published.",
        });
        skipped++;
      }
    } catch (e) {
      if (e instanceof UploadError && e.status === 422) {
        // Permanently invalid content — fail it, don't retry.
        await scoped.cardImports.setRowOutcome(c.id, {
          outcome: "failed",
          reason: e.message,
        });
        failed++;
      } else {
        // Transient/unexpected — return to pending for a later tick (bounded by attempts).
        await scoped.cardImports.setRowOutcome(c.id, {
          outcome: "pending",
          claimedAt: null,
        });
      }
    }
  }

  // Recompute counts and settle status for every import a row was processed for.
  for (const [importId, orgId] of touched) {
    await settleImport(orgDb(orgId, db), importId);
  }

  return { drained, published, skipped, failed };
}

interface Counts {
  published: number;
  skipped: number;
  failed: number;
}

/** The terminal status for a settled import from its outcome tally. */
function settleStatus(t: Counts): "completed" | "completed_with_errors" | "failed" {
  if (t.failed === 0 && t.skipped === 0) return "completed";
  if (t.published === 0 && t.skipped === 0) return "failed"; // only hard failures
  return "completed_with_errors";
}

/**
 * Recompute an import's counts from its rows and, once no row is pending or processing,
 * settle its status and stamp completed_at. Writes the finish audit exactly once, on the
 * transition from a non-terminal to a terminal status (AC-10).
 */
async function settleImport(scoped: OrgDb, importId: string): Promise<void> {
  const current = await scoped.cardImports.get(importId);
  if (!current) return;
  const t = await scoped.cardImports.outcomeCounts(importId);
  const unsettled = t.pending + t.processing;
  const counts: Counts = {
    published: t.published,
    skipped: t.skipped,
    failed: t.failed,
  };

  if (unsettled > 0) {
    await scoped.cardImports.updateImport(importId, {
      status: "processing",
      publishedCount: t.published,
      skippedCount: t.skipped,
      failedCount: t.failed,
    });
    return;
  }

  await scoped.cardImports.updateImport(importId, {
    status: settleStatus(counts),
    publishedCount: t.published,
    skippedCount: t.skipped,
    failedCount: t.failed,
    completedAt: new Date(),
  });
  if (!TERMINAL_STATUSES.has(current.status)) {
    await appendFinishAudit(scoped, importId, current.actorUserId, counts);
  }
}

async function appendFinishAudit(
  scoped: OrgDb,
  importId: string,
  actorUserId: string,
  counts: Counts,
): Promise<void> {
  await scoped.audit.append({
    actorUserId,
    action: "card.import_finished",
    targetType: "card_import",
    targetId: importId,
    metadataJson: JSON.stringify(counts),
  });
}
