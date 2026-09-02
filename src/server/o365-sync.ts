import { getCloudflareContext } from "@opennextjs/cloudflare";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getAppSettings } from "./app-settings";
import { buildDb } from "./db";
import { files } from "./db/schema";
import {
  findUsersByEmail,
  type GraphEnv,
  graphConfigured,
  patchUserExtensionAttribute1,
} from "./graph";
import { orgDb } from "./org-db";
import { publicUrlFor, type UploadEnv } from "./uploads";

/** The sync runs only when the credentials are present AND the Settings toggle is on. */
async function o365Active(env: O365SyncEnv): Promise<boolean> {
  if (!graphConfigured(env)) return false;
  return (await getAppSettings(env)).o365SyncEnabled;
}

// Office 365 CustomAttribute1 sync (spec 0010). For one card, write its public
// .vcf URL into the matched staff member's Exchange CustomAttribute1, or clear it
// when the card is not a live published vCard. Idempotent (only PATCH on a diff)
// and best effort (never throws; records the outcome). Called after publish/edit
// (set) and unpublish/delete (clear), and by the nightly reconcile.

export type O365SyncEnv = UploadEnv & GraphEnv;

type SyncStatus = "synced" | "cleared" | "no_match" | "ambiguous" | "error";

interface SyncStateUpdate {
  o365UserId?: string | null;
  o365SyncedUrl?: string | null;
  o365SyncStatus: SyncStatus;
  o365SyncError?: string | null;
}

async function writeState(
  env: O365SyncEnv,
  fileId: string,
  orgId: string,
  action: "o365.synced" | "o365.cleared" | "o365.sync_failed",
  state: SyncStateUpdate,
): Promise<void> {
  const db = buildDb(env.DB);
  await db
    .update(files)
    .set({
      o365UserId: state.o365UserId ?? null,
      o365SyncedUrl: state.o365SyncedUrl ?? null,
      o365SyncedAt: new Date(),
      o365SyncStatus: state.o365SyncStatus,
      o365SyncError: state.o365SyncError ?? null,
    })
    .where(eq(files.id, fileId));
  // Audit through the org-scoped helper (the sync is a system action, actor null).
  await orgDb(orgId, db).audit.append({
    actorUserId: null,
    action,
    targetType: "file",
    targetId: fileId,
    metadataJson: JSON.stringify({
      status: state.o365SyncStatus,
      userId: state.o365UserId ?? null,
      url: state.o365SyncedUrl ?? null,
    }),
  });
}

/**
 * Sync one card to Office 365. Reads the card's current state and reconciles:
 *  - a live published vCard with exactly one email match → write its URL;
 *  - unpublished/deleted, or no/ambiguous match → clear any value we set before.
 * A no-op when the sync is disabled or unconfigured. Never throws.
 */
export async function syncCardToO365(
  env: O365SyncEnv,
  fileId: string,
): Promise<void> {
  if (!(await o365Active(env))) return;

  const db = buildDb(env.DB);
  const [file] = await db
    .select({
      id: files.id,
      orgId: files.orgId,
      kind: files.kind,
      visibility: files.visibility,
      deletedAt: files.deletedAt,
      publicSlug: files.publicSlug,
      contactEmail: files.contactEmail,
      o365UserId: files.o365UserId,
      o365SyncedUrl: files.o365SyncedUrl,
    })
    .from(files)
    .where(eq(files.id, fileId))
    .limit(1);
  if (!file) return;

  const isLive =
    file.kind === "vcard" &&
    file.visibility === "public" &&
    !file.deletedAt &&
    Boolean(file.publicSlug);
  const targetUrl = isLive ? (publicUrlFor(env, file.publicSlug) ?? null) : null;
  const prevUserId = file.o365UserId;
  const prevUrl = file.o365SyncedUrl;

  try {
    // Not a live published card: clear anything we set, mark cleared.
    if (!targetUrl) {
      if (prevUserId && prevUrl) {
        await patchUserExtensionAttribute1(env, prevUserId, null);
      }
      await writeState(env, fileId, file.orgId, "o365.cleared", {
        o365UserId: null,
        o365SyncedUrl: null,
        o365SyncStatus: "cleared",
      });
      return;
    }

    // Live card but no email to match: nothing to write; clear a stale value.
    const email = file.contactEmail?.trim();
    if (!email) {
      if (prevUserId && prevUrl) {
        await patchUserExtensionAttribute1(env, prevUserId, null);
      }
      await writeState(env, fileId, file.orgId, "o365.cleared", {
        o365UserId: null,
        o365SyncedUrl: null,
        o365SyncStatus: "no_match",
      });
      return;
    }

    const matches = await findUsersByEmail(env, email);
    if (matches.length !== 1) {
      // Zero or many mailboxes for this email: do not write. Clear a stale value.
      if (prevUserId && prevUrl) {
        await patchUserExtensionAttribute1(env, prevUserId, null);
      }
      await writeState(env, fileId, file.orgId, "o365.cleared", {
        o365UserId: null,
        o365SyncedUrl: null,
        o365SyncStatus: matches.length === 0 ? "no_match" : "ambiguous",
      });
      return;
    }

    const user = matches[0];
    // The match moved to a different mailbox: clear the old one first.
    if (prevUserId && prevUserId !== user.id && prevUrl) {
      await patchUserExtensionAttribute1(env, prevUserId, null);
    }
    // Idempotent: only write when the live attribute differs from the target.
    if (user.currentAttr !== targetUrl) {
      await patchUserExtensionAttribute1(env, user.id, targetUrl);
    }
    await writeState(env, fileId, file.orgId, "o365.synced", {
      o365UserId: user.id,
      o365SyncedUrl: targetUrl,
      o365SyncStatus: "synced",
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await writeState(env, fileId, file.orgId, "o365.sync_failed", {
      // Keep the prior match/url so a later run can retry against it.
      o365UserId: prevUserId,
      o365SyncedUrl: prevUrl,
      o365SyncStatus: "error",
      o365SyncError: message.slice(0, 500),
    }).catch(() => {});
  }
}

/**
 * Fire-and-forget trigger for the request paths (publish/edit/unpublish/delete).
 * Runs after the response via ctx.waitUntil, so it never blocks or fails the user
 * action. A no-op when sync is disabled. Call it after the action commits.
 */
export function triggerO365Sync(env: O365SyncEnv, fileId: string): void {
  // Cheap sync guard; syncCardToO365 does the full check (credentials + toggle).
  if (!graphConfigured(env)) return;
  const p = syncCardToO365(env, fileId).catch(() => {});
  try {
    getCloudflareContext().ctx.waitUntil(p);
  } catch {
    // No request context (e.g. a test); the promise still runs on its own.
  }
}

/**
 * Nightly reconcile (spec 0010, AC-4): re-assert every live published vCard across
 * all orgs. Each card sync is idempotent (writes only on a diff) and best effort,
 * so a single failure never stops the run. Returns a small summary.
 */
export async function reconcileO365(
  env: O365SyncEnv,
): Promise<{ enabled: boolean; processed: number }> {
  if (!(await o365Active(env))) return { enabled: false, processed: 0 };
  const db = buildDb(env.DB);
  const rows = await db
    .select({ id: files.id })
    .from(files)
    .where(
      and(
        eq(files.kind, "vcard"),
        eq(files.visibility, "public"),
        isNull(files.deletedAt),
      ),
    );
  for (const row of rows) {
    await syncCardToO365(env, row.id);
  }
  return { enabled: true, processed: rows.length };
}

export interface O365Summary {
  synced: number;
  no_match: number;
  ambiguous: number;
  error: number;
}

/** Per-org counts of the sync status across published cards, for the Settings view. */
export async function o365Summary(
  env: O365SyncEnv,
  orgId: string,
): Promise<O365Summary> {
  const db = buildDb(env.DB);
  const rows = await db
    .select({ status: files.o365SyncStatus, n: sql<number>`count(*)` })
    .from(files)
    .where(
      and(
        eq(files.orgId, orgId),
        eq(files.kind, "vcard"),
        isNull(files.deletedAt),
      ),
    )
    .groupBy(files.o365SyncStatus);
  const out: O365Summary = { synced: 0, no_match: 0, ambiguous: 0, error: 0 };
  for (const r of rows) {
    if (r.status === "synced") out.synced = Number(r.n);
    else if (r.status === "no_match") out.no_match = Number(r.n);
    else if (r.status === "ambiguous") out.ambiguous = Number(r.n);
    else if (r.status === "error") out.error = Number(r.n);
  }
  return out;
}
