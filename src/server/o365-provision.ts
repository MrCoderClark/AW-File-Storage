import { and, eq, isNull } from "drizzle-orm";
import { buildVcard, type CardFields } from "../lib/vcard-builder";
import { buildDb, type Db } from "./db";
import { files, member, orgDomains, orgSettings } from "./db/schema";
import { domainOf, isConsumerDomain } from "./domains";
import { type GraphDirectoryUser, listDirectoryUsers } from "./graph";
import { loadGraphCreds, type O365SyncEnv, syncCardToO365 } from "./o365-sync";
import { orgDb } from "./org-db";
import { autoUnpublishVcard, publishVcardFromBytes } from "./uploads";

// Auto-provision contact cards from the Office 365 directory (spec 0016). For each
// org that has opted in (o365AutoCardEnabled) and has credentials, build + publish a
// vCard from each licensed, mailboxed user's directory details and write its URL into
// CustomAttribute1; and unpublish an auto-created card when its user is offboarded
// (disabled / unlicensed / mailbox gone). A cross-org SYSTEM job — it must span every
// org, so it uses the raw client (on the no-db-bypass allowlist) but confines every
// write to the org whose own credentials + verified domains it is sweeping.

export type O365ProvisionEnv = O365SyncEnv;

export interface ProvisionSummary {
  created: number;
  unpublished: number;
  skipped: number;
}

/** The org's owner (else any admin) — the user an auto-created card is attributed to. */
async function orgUploaderUserId(db: Db, orgId: string): Promise<string | null> {
  for (const role of ["owner", "admin"] as const) {
    const [row] = await db
      .select({ userId: member.userId })
      .from(member)
      .where(and(eq(member.organizationId, orgId), eq(member.role, role)))
      .limit(1);
    if (row) return row.userId;
  }
  return null;
}

/** A directory user is in scope when enabled, licensed, and has a mailbox (`mail`). */
function inScope(u: GraphDirectoryUser): boolean {
  return u.accountEnabled && u.licensed && Boolean(u.mail);
}

/**
 * Map a directory user to card fields, or null when there is not enough to build a
 * meaningful card (no name at all). Website is intentionally omitted — it is
 * org-specific and not derivable from the directory (a per-org follow-up).
 */
function userToCard(u: GraphDirectoryUser): CardFields | null {
  const parts = (u.displayName ?? "").split(/\s+/).filter(Boolean);
  const firstName = u.givenName ?? parts[0] ?? "";
  const lastName = u.surname ?? parts.slice(1).join(" ") ?? "";
  if (!firstName && !lastName && !u.displayName) return null;
  return {
    firstName,
    lastName,
    fullName: u.displayName ?? undefined,
    email: u.mail as string,
    mobilePhone: u.mobilePhone ?? undefined,
    workPhone: u.businessPhones[0] ?? undefined,
    organization: u.companyName ?? undefined,
    jobTitle: u.jobTitle ?? undefined,
    street: u.streetAddress ?? undefined,
    city: u.city ?? undefined,
    state: u.state ?? undefined,
    zip: u.postalCode ?? undefined,
    country: u.country ?? undefined,
  };
}

/**
 * Provision cards for one org (create + offboard passes). No-op unless the org has
 * the auto-card toggle on, its O365 sync toggle on, and usable credentials. Best
 * effort per user; a single failure never stops the sweep. Not thrown from.
 */
export async function provisionCardsForOrg(
  env: O365ProvisionEnv,
  orgId: string,
): Promise<ProvisionSummary> {
  const summary: ProvisionSummary = { created: 0, unpublished: 0, skipped: 0 };
  const db = buildDb(env.DB);

  const s = await orgDb(orgId, db).settings.get();
  if (!s.o365SyncEnabled || !s.o365AutoCardEnabled) return summary;
  // Forward-only: only users created at/after the cutoff (set when the toggle was
  // enabled) are provisioned — existing staff are never backfilled. No cutoff means
  // create nothing (fail safe toward not backfilling).
  const cutoff = s.o365AutoCardSince;
  const creds = await loadGraphCreds(env, orgId, db);
  if (!creds) return summary;
  const uploader = await orgUploaderUserId(db, orgId);
  if (!uploader) return summary; // no user to attribute cards to

  let users: GraphDirectoryUser[];
  try {
    users = await listDirectoryUsers(creds);
  } catch {
    return summary; // Graph unreachable this run; the next tick retries.
  }
  const usersById = new Map(users.map((u) => [u.id, u]));

  // This org's own verified domains, so a user is only ever filed here when their
  // email domain belongs to THIS org (one query, no cross-org lookup per user).
  const domainRows = await db
    .select({ domain: orgDomains.domain })
    .from(orgDomains)
    .where(eq(orgDomains.orgId, orgId));
  const ownDomains = new Set(domainRows.map((d) => d.domain.toLowerCase()));
  const belongsHere = (email: string): boolean => {
    const d = domainOf(email);
    return Boolean(d) && !isConsumerDomain(d) && ownDomains.has(d);
  };

  // Live published vCards already in this org, to skip anyone who has a card
  // (non-clobber) and to drive the offboard pass over auto-created ones.
  const liveCards = await db
    .select({
      id: files.id,
      contactEmail: files.contactEmail,
      o365UserId: files.o365UserId,
      source: files.source,
    })
    .from(files)
    .where(
      and(
        eq(files.orgId, orgId),
        eq(files.kind, "vcard"),
        eq(files.visibility, "public"),
        isNull(files.deletedAt),
      ),
    );
  const haveCardForEmail = new Set(
    liveCards.map((c) => c.contactEmail?.toLowerCase()).filter(Boolean),
  );

  // Create pass: in-scope users, in this org's domains, without an existing card.
  for (const u of users) {
    if (!inScope(u)) continue;
    // Only users created since the feature was enabled (never backfill existing).
    if (!cutoff || !u.createdDateTime || u.createdDateTime < cutoff) continue;
    const email = (u.mail as string).toLowerCase();
    if (!belongsHere(email)) continue;
    if (haveCardForEmail.has(email)) continue;

    const fields = userToCard(u);
    if (!fields) {
      summary.skipped++;
      continue;
    }
    try {
      const res = await publishVcardFromBytes(env, orgId, buildVcard(fields), {
        uploadedBy: uploader,
        source: "o365_auto",
        o365UserId: u.id,
      });
      if (res.created) {
        // Write the card's public URL into the user's CustomAttribute1.
        await syncCardToO365(env, res.fileId);
        summary.created++;
        haveCardForEmail.add(email); // guard against duplicate userPrincipal rows
      }
    } catch {
      summary.skipped++; // bad bytes / transient; the next tick retries
    }
  }

  // Offboard pass: an auto-created card whose user is gone/disabled/unlicensed →
  // unpublish it and clear the attribute (human-authored cards are never touched).
  for (const card of liveCards) {
    if (card.source !== "o365_auto") continue;
    const u = card.o365UserId ? usersById.get(card.o365UserId) : undefined;
    if (u && inScope(u)) continue; // still active — leave published
    try {
      await autoUnpublishVcard(env, orgId, card.id);
      await syncCardToO365(env, card.id); // card no longer live → clears attribute
      summary.unpublished++;
    } catch {
      summary.skipped++;
    }
  }

  return summary;
}

/** Provision every opted-in org (the frequent poll + nightly sweep call this). */
export async function provisionCardsAllOrgs(
  env: O365ProvisionEnv,
): Promise<ProvisionSummary> {
  const total: ProvisionSummary = { created: 0, unpublished: 0, skipped: 0 };
  if (!env.O365_CRED_KEK) return total;
  const db = buildDb(env.DB);
  // Only orgs that have opted in; each is fully re-checked in provisionCardsForOrg.
  const enabled = await db
    .select({ orgId: orgSettings.orgId })
    .from(orgSettings)
    .where(eq(orgSettings.o365AutoCardEnabled, true));
  for (const { orgId } of enabled) {
    const s = await provisionCardsForOrg(env, orgId);
    total.created += s.created;
    total.unpublished += s.unpublished;
    total.skipped += s.skipped;
  }
  return total;
}
