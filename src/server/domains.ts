import { and, eq } from "drizzle-orm";
import { buildDb } from "./db";
import { organization, orgDomains } from "./db/schema";
import { getVerifiedDomains, type GraphCreds } from "./graph";
import { uuidv7 } from "./id";

/**
 * Org verified domains (spec 0014): the source for domain-based provisioning. A
 * domain maps to at most one org; consumer/free-mail domains never match or get
 * claimed. Domains come from an org's Microsoft tenant (Graph GET /domains) or are
 * added manually by the platform owner. Cross-org reads here (resolveOrgForEmail)
 * are platform-level and gated at the route.
 */

export interface DomainsEnv {
  DB: D1Database;
}

// Free/consumer mail providers — never mapped to an org or claimable.
const CONSUMER_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "fastmail.com",
]);

export function isConsumerDomain(domain: string): boolean {
  return CONSUMER_DOMAINS.has(domain.trim().toLowerCase());
}

/** The lower-cased domain of an email, or "" if malformed. */
export function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  if (at === -1) return "";
  return email.slice(at + 1).trim().toLowerCase();
}

export class DomainError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface OrgDomainRow {
  id: string;
  domain: string;
  source: "o365" | "manual";
  verifiedAt: string | null;
}

/** An org's verified domains (for the management UI), newest first. */
export async function listOrgDomains(
  env: DomainsEnv,
  orgId: string,
): Promise<OrgDomainRow[]> {
  const db = buildDb(env.DB);
  const rows = await db
    .select({
      id: orgDomains.id,
      domain: orgDomains.domain,
      source: orgDomains.source,
      verifiedAt: orgDomains.verifiedAt,
    })
    .from(orgDomains)
    .where(eq(orgDomains.orgId, orgId))
    .orderBy(orgDomains.domain);
  return rows.map((r) => ({
    id: r.id,
    domain: r.domain,
    source: r.source as "o365" | "manual",
    verifiedAt: r.verifiedAt ? new Date(r.verifiedAt).toISOString() : null,
  }));
}

/**
 * Fetch the org's verified Microsoft domains and record them (source 'o365'):
 * skips consumer domains and any domain already claimed by ANOTHER org, and is
 * idempotent (a domain already on this org is left as-is). Best effort — a Graph
 * failure throws to the caller, which treats domain sync as non-fatal.
 */
export async function syncOrgDomains(
  env: DomainsEnv,
  orgId: string,
  creds: GraphCreds,
): Promise<number> {
  const domains = await getVerifiedDomains(creds);
  const db = buildDb(env.DB);
  let added = 0;
  for (const domain of domains) {
    if (isConsumerDomain(domain)) continue;
    const [existing] = await db
      .select({ orgId: orgDomains.orgId })
      .from(orgDomains)
      .where(eq(orgDomains.domain, domain))
      .limit(1);
    if (existing) continue; // ours already, or claimed by another org — leave it
    await db
      .insert(orgDomains)
      .values({
        id: uuidv7(),
        orgId,
        domain,
        source: "o365",
        verifiedAt: new Date(),
        createdAt: new Date(),
      })
      .onConflictDoNothing();
    added++;
  }
  return added;
}

/** Add a domain to an org manually (platform owner). Rejects consumer + claimed. */
export async function addManualDomain(
  env: DomainsEnv,
  orgId: string,
  rawDomain: string,
): Promise<void> {
  const domain = rawDomain.trim().toLowerCase().replace(/^@/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    throw new DomainError(400, "Enter a valid domain, e.g. h2tecs.com.");
  }
  if (isConsumerDomain(domain)) {
    throw new DomainError(400, "Consumer email domains can't be claimed.");
  }
  const db = buildDb(env.DB);
  const [existing] = await db
    .select({ orgId: orgDomains.orgId })
    .from(orgDomains)
    .where(eq(orgDomains.domain, domain))
    .limit(1);
  if (existing) {
    throw new DomainError(
      409,
      existing.orgId === orgId
        ? "That domain is already on this organization."
        : "That domain is already claimed by another organization.",
    );
  }
  await db.insert(orgDomains).values({
    id: uuidv7(),
    orgId,
    domain,
    source: "manual",
    verifiedAt: new Date(),
    createdAt: new Date(),
  });
}

/** Remove one of an org's domains. */
export async function removeDomain(
  env: DomainsEnv,
  orgId: string,
  domainId: string,
): Promise<void> {
  const db = buildDb(env.DB);
  await db
    .delete(orgDomains)
    .where(and(eq(orgDomains.id, domainId), eq(orgDomains.orgId, orgId)));
}

export interface DomainMatch {
  orgId: string;
  orgName: string;
}

/** The org that owns an email's domain, or null (consumer / no verified match). */
export async function resolveOrgForEmail(
  env: DomainsEnv,
  email: string,
): Promise<DomainMatch | null> {
  const domain = domainOf(email);
  if (!domain || isConsumerDomain(domain)) return null;
  const db = buildDb(env.DB);
  const [row] = await db
    .select({ orgId: orgDomains.orgId, orgName: organization.name })
    .from(orgDomains)
    .innerJoin(organization, eq(organization.id, orgDomains.orgId))
    .where(eq(orgDomains.domain, domain))
    .limit(1);
  return row ? { orgId: row.orgId, orgName: row.orgName } : null;
}
