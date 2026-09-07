import { and, eq, isNull, or } from "drizzle-orm";
import { buildVcard, type CardFields } from "../lib/vcard-builder";
import { buildDb, type Db } from "./db";
import { files, member, orgDomains, orgSettings } from "./db/schema";
import { domainOf, isConsumerDomain } from "./domains";
import {
  type GraphDirectoryUser,
  graphUserExists,
  listDeletedUsers,
  listDirectoryUsers,
} from "./graph";
import { loadGraphCreds, type O365SyncEnv, syncCardToO365 } from "./o365-sync";
import { orgDb } from "./org-db";
import {
  autoDeleteCard,
  autoUnpublishVcard,
  publishVcardFromBytes,
} from "./uploads";

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
  deleted: number;
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
  const summary: ProvisionSummary = { created: 0, unpublished: 0, deleted: 0, skipped: 0 };
  const db = buildDb(env.DB);

  const s = await orgDb(orgId, db).settings.get();
  // Needs sync on plus at least one of the two behaviors; else nothing to do.
  if (!s.o365SyncEnabled || (!s.o365AutoCardEnabled && !s.o365RemoveOnOffboardEnabled))
    return summary;
  const creds = await loadGraphCreds(env, orgId, db);
  if (!creds) return summary;

  let users: GraphDirectoryUser[];
  try {
    users = await listDirectoryUsers(creds);
  } catch {
    return summary; // Graph unreachable this run; the next tick retries.
  }

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

  // Create pass (spec 0016): in-scope users created since the cutoff, in this org's
  // domains, without an existing card. Gated by the auto-card toggle.
  if (s.o365AutoCardEnabled) {
    // Forward-only: only users created at/after the cutoff (stamped when the toggle
    // was enabled) — existing staff are never backfilled. No cutoff → create nothing.
    const cutoff = s.o365AutoCardSince;
    const uploader = await orgUploaderUserId(db, orgId);
    if (cutoff && uploader) {
      for (const u of users) {
        if (!inScope(u)) continue;
        if (!u.createdDateTime || u.createdDateTime < cutoff) continue;
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
            await syncCardToO365(env, res.fileId); // write the URL into CustomAttribute1
            summary.created++;
            haveCardForEmail.add(email); // guard against duplicate userPrincipal rows
          }
        } catch {
          summary.skipped++; // bad bytes / transient; the next tick retries
        }
      }
    }
  }

  // Offboard pass (spec 0017): retract cards — auto OR human-made — for departed
  // users, where "departed" is a POSITIVE signal (present in the directory AND
  // disabled AND unlicensed), matched by email and confined to this org's own O365
  // domains. A user merely absent from the listing is never treated as offboarded.
  if (s.o365RemoveOnOffboardEnabled) {
    // Disabled + unlicensed, still present in the directory — matched by email.
    const offboardedEmails = new Set(
      users
        .filter((u) => u.mail && !u.accountEnabled && !u.licensed)
        .map((u) => (u.mail as string).toLowerCase()),
    );
    // Hard-deleted users (spec 0019) — a positive signal from Entra's recycle bin.
    // Matched by the card's stored Graph user id (reliable even when a deleted user's
    // email is mangled), plus email when the deleted record still has one. Missing
    // permission / unavailable → treated as "no deletions this run" (the disable path
    // still works, and the 404-tolerant clear stops the recurring sync error anyway).
    const deletedIds = new Set<string>();
    // Whether the recycle-bin read succeeded. Needed to tell a PERMANENT delete (gone
    // from the recycle bin too → card is deleted immediately) from a SOFT delete (still
    // in the recycle bin, restorable → card gets the 30-day grace). If the read fails,
    // we cannot distinguish, so we fall back to the safe retract-with-grace.
    let recycleBinReadOk = true;
    try {
      for (const d of await listDeletedUsers(creds)) {
        deletedIds.add(d.id);
        if (d.mail) offboardedEmails.add(d.mail.toLowerCase());
      }
    } catch {
      recycleBinReadOk = false; // deletedItems unavailable (e.g. missing permission)
    }
    // Ids of all users still in the tenant (enabled or disabled), so we can spot a
    // card whose matched user is in NEITHER the active directory nor the recycle bin.
    const activeUserIds = new Set(users.map((u) => u.id));

    for (const card of liveCards) {
      const email = card.contactEmail?.toLowerCase();
      const byEmail = Boolean(email && offboardedEmails.has(email));
      const byDeletedId = Boolean(
        card.o365UserId && deletedIds.has(card.o365UserId),
      );
      // Permanently-deleted (purged) user: the card's matched id is in neither the
      // active directory nor the recycle bin. Confirm with a DIRECT lookup — a 404 is
      // a provable deletion, whereas a transient listing gap would still return the
      // user here (so a glitch can never trigger a retraction).
      let byPurged = false;
      if (
        !byEmail &&
        !byDeletedId &&
        card.o365UserId &&
        !activeUserIds.has(card.o365UserId) &&
        !deletedIds.has(card.o365UserId)
      ) {
        try {
          byPurged = !(await graphUserExists(creds, card.o365UserId));
        } catch {
          byPurged = false; // uncertain (transient / permission) — never act on doubt
        }
      }
      if (!byEmail && !byDeletedId && !byPurged) continue;
      if (!email || !belongsHere(email)) continue; // confine to the org's own domain(s)
      // A PERMANENT delete — confirmed gone via the direct lookup AND confirmed absent
      // from the recycle bin (the read succeeded and didn't contain it) — is
      // unrecoverable, so the card is DELETED now rather than kept for the 30-day
      // grace. Everything else (disable+unlicense, soft delete, or an uncertain
      // recycle-bin read) is retracted with the grace, since it may be reversible.
      const permanentlyDeleted = byPurged && recycleBinReadOk;
      try {
        if (permanentlyDeleted) {
          // The user is gone, so there is no mailbox attribute left to clear — just
          // delete the card (removes the public object + soft-deletes the row).
          await autoDeleteCard(env, orgId, card.id);
          summary.deleted++;
        } else {
          await autoUnpublishVcard(env, orgId, card.id, { offboarded: true });
          await syncCardToO365(env, card.id); // card no longer live → clears attribute
          summary.unpublished++;
        }
      } catch {
        summary.skipped++;
      }
    }
  }

  return summary;
}

/** Provision every opted-in org (the frequent poll + nightly sweep call this). */
export async function provisionCardsAllOrgs(
  env: O365ProvisionEnv,
): Promise<ProvisionSummary> {
  const total: ProvisionSummary = { created: 0, unpublished: 0, deleted: 0, skipped: 0 };
  if (!env.O365_CRED_KEK) return total;
  const db = buildDb(env.DB);
  // Orgs opted into either behavior; each is fully re-checked in provisionCardsForOrg.
  const enabled = await db
    .select({ orgId: orgSettings.orgId })
    .from(orgSettings)
    .where(
      or(
        eq(orgSettings.o365AutoCardEnabled, true),
        eq(orgSettings.o365RemoveOnOffboardEnabled, true),
      ),
    );
  for (const { orgId } of enabled) {
    const s = await provisionCardsForOrg(env, orgId);
    total.created += s.created;
    total.unpublished += s.unpublished;
    total.deleted += s.deleted;
    total.skipped += s.skipped;
  }
  return total;
}
