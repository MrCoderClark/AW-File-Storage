import { and, eq, inArray } from "drizzle-orm";
import { type AuthEnv } from "./auth";
import { buildDb } from "./db";
import * as schema from "./db/schema";
import { type DomainMatch, resolveOrgForEmail } from "./domains";
import { inviteEmail, sendEmail } from "./email";
import { uuidv7 } from "./id";
import { createOrOnboardUser } from "./invitations";

/**
 * Platform-owner provisioning (spec 0014): put a user into one or more orgs. New
 * accounts go through the same secure invite -> accept flow (a `provision` record
 * carries the multi-org assignment list); existing accounts get memberships added
 * directly. All callers are gated by isPlatformOwner at the route.
 */

const PROVISION_TTL_DAYS = 7;
const PROVISION_TTL_MS = PROVISION_TTL_DAYS * 24 * 60 * 60 * 1000;

export type ProvRole = "admin" | "member";
export interface Assignment {
  orgId: string;
  role: ProvRole;
}

export class ProvisionError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The org suggested for an email by its verified domain (for the console pre-select). */
export async function suggestOrgForEmail(
  env: AuthEnv,
  email: string,
): Promise<DomainMatch | null> {
  return resolveOrgForEmail(env, email);
}

export interface EmailLookup {
  /** The org suggested by the email's verified domain, or null. */
  match: DomainMatch | null;
  /** Org ids the email's account is already a member of (grey these out). */
  existingOrgIds: string[];
  /** Whether an account already exists for this email. */
  accountExists: boolean;
}

/**
 * Everything the console needs when an email is entered (spec 0014): the
 * domain-suggested org, which orgs the person already belongs to (so they can be
 * disabled), and whether the account already exists (so the right mode is picked).
 */
export async function lookupEmail(
  env: AuthEnv,
  rawEmail: string,
): Promise<EmailLookup> {
  const email = rawEmail.trim().toLowerCase();
  const match = await resolveOrgForEmail(env, email);
  const db = buildDb(env.DB);
  const [u] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email))
    .limit(1);
  if (!u) return { match, existingOrgIds: [], accountExists: false };
  const memberships = await db
    .select({ orgId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, u.id));
  return {
    match,
    existingOrgIds: memberships.map((m) => m.orgId),
    accountExists: true,
  };
}

/** Every organization (id + name), for the provisioning org picker. Platform-owner use. */
export async function listAllOrgs(
  env: AuthEnv,
): Promise<Array<{ id: string; name: string }>> {
  const db = buildDb(env.DB);
  return db
    .select({ id: schema.organization.id, name: schema.organization.name })
    .from(schema.organization)
    .orderBy(schema.organization.name);
}

/** Validate the assignment list against real orgs and roles; returns a clean list. */
async function validateAssignments(
  db: ReturnType<typeof buildDb>,
  assignments: Assignment[],
): Promise<Assignment[]> {
  const clean = assignments
    .filter((a) => a && typeof a.orgId === "string")
    .map((a) => ({
      orgId: a.orgId,
      role: (a.role === "admin" ? "admin" : "member") as ProvRole,
    }));
  // De-dupe by orgId (last role wins).
  const byOrg = new Map<string, Assignment>();
  for (const a of clean) byOrg.set(a.orgId, a);
  const list = [...byOrg.values()];
  if (list.length === 0) {
    throw new ProvisionError(400, "Choose at least one organization.");
  }
  const orgIds = list.map((a) => a.orgId);
  const found = await db
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(inArray(schema.organization.id, orgIds));
  const real = new Set(found.map((o) => o.id));
  const missing = orgIds.filter((id) => !real.has(id));
  if (missing.length > 0) {
    throw new ProvisionError(400, "One or more organizations no longer exist.");
  }
  return list;
}

/**
 * Provision a NEW (or removed) account: create a pending provision + email an
 * accept link. Orgs the person is already a member of are dropped; if none remain,
 * this is a no-op error. One pending provision per email at a time.
 */
export async function createProvision(opts: {
  env: AuthEnv;
  email: string;
  assignments: Assignment[];
  createdBy: string;
}): Promise<{ id: string; url: string }> {
  const email = opts.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new ProvisionError(400, "Enter a valid email address.");
  }
  const db = buildDb(opts.env.DB);
  const assignments = await validateAssignments(db, opts.assignments);

  // Drop orgs the user is already a member of.
  const [existingUser] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email))
    .limit(1);
  let pending = assignments;
  if (existingUser) {
    const memberships = await db
      .select({ orgId: schema.member.organizationId })
      .from(schema.member)
      .where(eq(schema.member.userId, existingUser.id));
    const inOrg = new Set(memberships.map((m) => m.orgId));
    pending = assignments.filter((a) => !inOrg.has(a.orgId));
  }
  if (pending.length === 0) {
    throw new ProvisionError(
      409,
      "That person is already a member of the chosen organization(s).",
    );
  }

  // One live provision per email.
  await db
    .update(schema.provision)
    .set({ status: "cancelled" })
    .where(and(eq(schema.provision.email, email), eq(schema.provision.status, "pending")));

  const id = uuidv7();
  await db.insert(schema.provision).values({
    id,
    email,
    status: "pending",
    expiresAt: new Date(Date.now() + PROVISION_TTL_MS),
    assignments: JSON.stringify(pending),
    createdBy: opts.createdBy,
    createdAt: new Date(),
  });

  const url = `${opts.env.APP_URL}/accept-invitation/${id}`;
  await sendEmail(
    {
      apiKey: opts.env.RESEND_API_KEY,
      from: opts.env.EMAIL_FROM ?? "no-reply@americaworks.com",
    },
    {
      to: email,
      subject: "You're invited to AW File Storage",
      html: inviteEmail({
        url,
        role: pending[0].role,
        expiresInDays: PROVISION_TTL_DAYS,
      }),
    },
  );
  return { id, url };
}

/** Read-only preview of a provision by id (for the accept page). */
export async function previewProvision(
  env: AuthEnv,
  provisionId: string,
): Promise<{ status: "valid" | "invalid" | "expired" | "used"; email?: string }> {
  const db = buildDb(env.DB);
  const [prov] = await db
    .select()
    .from(schema.provision)
    .where(eq(schema.provision.id, provisionId))
    .limit(1);
  if (!prov) return { status: "invalid" };
  if (prov.status === "accepted") return { status: "used" };
  if (prov.status !== "pending") return { status: "invalid" };
  if (new Date(prov.expiresAt).getTime() < Date.now()) return { status: "expired" };
  return { status: "valid", email: prov.email };
}

/**
 * Accept a provision: create/re-onboard the account and add EVERY assignment as a
 * membership, atomically (D1 batch), plus audit rows. First org becomes active on
 * sign-in (the session-create hook picks the first membership).
 */
export async function acceptProvision(opts: {
  env: AuthEnv;
  provisionId: string;
  name: string;
  password: string;
}): Promise<{ email: string; orgId: string }> {
  const { env, provisionId, name, password } = opts;
  const db = buildDb(env.DB);
  const [prov] = await db
    .select()
    .from(schema.provision)
    .where(and(eq(schema.provision.id, provisionId), eq(schema.provision.status, "pending")))
    .limit(1);
  if (!prov) throw new ProvisionError(400, "This link is invalid or already used.");
  if (new Date(prov.expiresAt).getTime() < Date.now()) {
    throw new ProvisionError(400, "This invitation has expired.");
  }
  const assignments = JSON.parse(prov.assignments) as Assignment[];

  const userId = await createOrOnboardUser(env, db, prov.email, name, password);

  // Which orgs is the user already in (skip those)? Reads before the batch.
  const existing = await db
    .select({ orgId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, userId));
  const already = new Set(existing.map((m) => m.orgId));

  const stmts: unknown[] = [
    db
      .update(schema.provision)
      .set({ status: "accepted" })
      .where(eq(schema.provision.id, provisionId)),
  ];
  for (const a of assignments) {
    if (already.has(a.orgId)) continue;
    const memberId = uuidv7();
    stmts.push(
      db.insert(schema.member).values({
        id: memberId,
        organizationId: a.orgId,
        userId,
        role: a.role,
        createdAt: new Date(),
      }),
    );
    stmts.push(
      db.insert(schema.auditEvents).values({
        orgId: a.orgId,
        actorUserId: userId,
        action: "member.joined",
        targetType: "member",
        targetId: memberId,
      }),
    );
  }
  // Dynamic length, so cast (via unknown) to D1's non-empty-tuple batch type.
  await db.batch(stmts as unknown as Parameters<typeof db.batch>[0]);

  return { email: prov.email, orgId: assignments[0].orgId };
}

/**
 * Assign an EXISTING account to org(s) directly — no email/accept, because the
 * account already exists. Skips memberships that already exist. Audited.
 */
export async function assignExistingUser(opts: {
  env: AuthEnv;
  email: string;
  assignments: Assignment[];
  actorUserId: string;
}): Promise<{ added: number }> {
  const email = opts.email.trim().toLowerCase();
  const db = buildDb(opts.env.DB);
  const assignments = await validateAssignments(db, opts.assignments);

  const [u] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email))
    .limit(1);
  if (!u) throw new ProvisionError(404, "No existing account with that email.");

  const memberships = await db
    .select({ orgId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, u.id));
  const inOrg = new Set(memberships.map((m) => m.orgId));

  let added = 0;
  for (const a of assignments) {
    if (inOrg.has(a.orgId)) continue;
    const memberId = uuidv7();
    await db.batch([
      db.insert(schema.member).values({
        id: memberId,
        organizationId: a.orgId,
        userId: u.id,
        role: a.role,
        createdAt: new Date(),
      }),
      db.insert(schema.auditEvents).values({
        orgId: a.orgId,
        actorUserId: opts.actorUserId,
        action: "member.added",
        targetType: "member",
        targetId: memberId,
      }),
    ]);
    added++;
  }
  return { added };
}
