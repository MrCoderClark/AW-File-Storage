import { and, eq } from "drizzle-orm";
import { type AuthEnv } from "./auth";
import { buildDb } from "./db";
import * as schema from "./db/schema";
import { createOrOnboardUser } from "./invitations";
import { uuidv7 } from "./id";

/**
 * SCIM 2.0 server core (spec 0015). Each org has a bearer token (only its SHA-256
 * HASH is stored). A presented token resolves to exactly ONE org; all operations
 * are confined to that org and can only add/suspend/remove a `member` membership
 * and update profile fields — never cross-org, never a role above member, never a
 * password. Security is the whole point: the token is the sensitive credential.
 */

export interface ScimEnv extends AuthEnv {
  SCIM_WELCOME_DELAY_MIN?: string;
}

// ---- token generation + hashing (Web Crypto; no Node crypto on Workers) ----

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh opaque SCIM token, shown to the operator once. */
export function generateScimToken(): string {
  return `scim_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/** SHA-256 hex of a token — the only form stored/compared. */
export async function hashScimToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Resolve the org for a presented `Authorization` header, or null (unauthenticated).
 * Touches last_used_at. The token maps to exactly one active org.
 */
export async function resolveScimOrg(
  env: ScimEnv,
  authHeader: string | null,
): Promise<string | null> {
  const token = (authHeader ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const hash = await hashScimToken(token);
  const db = buildDb(env.DB);
  const [row] = await db
    .select({ orgId: schema.scimToken.orgId, active: schema.scimToken.active })
    .from(schema.scimToken)
    .where(eq(schema.scimToken.tokenHash, hash))
    .limit(1);
  if (!row || !row.active) return null;
  await db
    .update(schema.scimToken)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.scimToken.orgId, row.orgId));
  return row.orgId;
}

// ---- token management (platform owner) ----

/** Generate (or rotate) an org's SCIM token; returns the plaintext ONCE. */
export async function setOrgScimToken(
  env: ScimEnv,
  orgId: string,
  createdBy: string,
): Promise<string> {
  const token = generateScimToken();
  const tokenHash = await hashScimToken(token);
  const db = buildDb(env.DB);
  await db
    .insert(schema.scimToken)
    .values({ orgId, tokenHash, active: true, createdBy, createdAt: new Date(), lastUsedAt: null })
    .onConflictDoUpdate({
      target: schema.scimToken.orgId,
      set: { tokenHash, active: true, createdBy, lastUsedAt: null },
    });
  return token;
}

export async function disableOrgScimToken(env: ScimEnv, orgId: string): Promise<void> {
  await buildDb(env.DB)
    .update(schema.scimToken)
    .set({ active: false })
    .where(eq(schema.scimToken.orgId, orgId));
}

export interface ScimConfig {
  configured: boolean;
  active: boolean;
  lastUsedAt: string | null;
}

export async function getScimConfig(env: ScimEnv, orgId: string): Promise<ScimConfig> {
  const [row] = await buildDb(env.DB)
    .select({ active: schema.scimToken.active, lastUsedAt: schema.scimToken.lastUsedAt })
    .from(schema.scimToken)
    .where(eq(schema.scimToken.orgId, orgId))
    .limit(1);
  return {
    configured: Boolean(row),
    active: Boolean(row?.active),
    lastUsedAt: row?.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : null,
  };
}

// ---- SCIM user operations (all confined to `orgId`) ----

export interface ScimUser {
  id: string;
  userName: string;
  givenName: string | null;
  familyName: string | null;
  active: boolean;
}

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";

/** A ScimUser as the SCIM JSON resource. */
export function toScimUserJson(u: ScimUser): Record<string, unknown> {
  return {
    schemas: [USER_SCHEMA],
    id: u.id,
    userName: u.userName,
    name: { givenName: u.givenName, familyName: u.familyName },
    emails: [{ value: u.userName, primary: true }],
    active: u.active,
    meta: { resourceType: "User" },
  };
}

/** A SCIM ListResponse envelope. */
export function scimListJson(users: ScimUser[]): Record<string, unknown> {
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults: users.length,
    startIndex: 1,
    itemsPerPage: users.length,
    Resources: users.map(toScimUserJson),
  };
}

/** A SCIM Error response (generic — no info leak). */
export function scimError(detail: string, status: number): Response {
  return Response.json(
    {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      detail,
      status: String(status),
    },
    { status, headers: { "Content-Type": "application/scim+json" } },
  );
}

function splitName(name: string): { given: string | null; family: string | null } {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { given: null, family: null };
  if (parts.length === 1) return { given: parts[0], family: null };
  return { given: parts[0], family: parts.slice(1).join(" ") };
}

async function auditScim(
  db: ReturnType<typeof buildDb>,
  orgId: string,
  action: string,
  memberOrUserId: string,
): Promise<void> {
  await db.insert(schema.auditEvents).values({
    orgId,
    actorUserId: null, // a machine (SCIM), not a person
    action,
    targetType: "member",
    targetId: memberOrUserId,
  });
}

/** The org's members as SCIM users; `filterEmail` returns the exact match only. */
export async function scimListUsers(
  env: ScimEnv,
  orgId: string,
  filterEmail?: string,
): Promise<ScimUser[]> {
  const db = buildDb(env.DB);
  const where = filterEmail
    ? and(
        eq(schema.member.organizationId, orgId),
        eq(schema.user.email, filterEmail.toLowerCase()),
      )
    : eq(schema.member.organizationId, orgId);
  const rows = await db
    .select({
      id: schema.user.id,
      email: schema.user.email,
      name: schema.user.name,
      status: schema.member.status,
    })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .where(where);
  return rows.map((r) => {
    const { given, family } = splitName(r.name);
    return {
      id: r.id,
      userName: r.email,
      givenName: given,
      familyName: family,
      active: (r.status ?? "active") !== "suspended",
    };
  });
}

/** One member of the org as a SCIM user (only if they belong to this org). */
export async function scimGetUser(
  env: ScimEnv,
  orgId: string,
  userId: string,
): Promise<ScimUser | null> {
  const db = buildDb(env.DB);
  const [row] = await db
    .select({
      id: schema.user.id,
      email: schema.user.email,
      name: schema.user.name,
      status: schema.member.status,
    })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .where(
      and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, userId)),
    )
    .limit(1);
  if (!row) return null;
  const { given, family } = splitName(row.name);
  return {
    id: row.id,
    userName: row.email,
    givenName: given,
    familyName: family,
    active: (row.status ?? "active") !== "suspended",
  };
}

/**
 * Create (onboard) a user in this org as a `member`, and QUEUE a set-password
 * email ~SCIM_WELCOME_DELAY_MIN later (mailbox-readiness). Never sets a password
 * or a role above member. Idempotent on the membership.
 */
export async function scimCreateUser(
  env: ScimEnv,
  orgId: string,
  input: { userName: string; givenName?: string | null; familyName?: string | null },
): Promise<ScimUser> {
  const email = input.userName.trim().toLowerCase();
  const name =
    [input.givenName, input.familyName].filter(Boolean).join(" ").trim() || email;
  const db = buildDb(env.DB);

  // Newly-created accounts get a set-password email; pre-existing ones don't.
  const [pre] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email))
    .limit(1);
  const isNew = !pre;

  // Onboard with an unusable random password; the user sets their own via email.
  const userId = await createOrOnboardUser(env, db, email, name, generateScimToken());

  // Add the org membership (member role) if not already present.
  const [existing] = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(
      and(eq(schema.member.userId, userId), eq(schema.member.organizationId, orgId)),
    )
    .limit(1);
  if (!existing) {
    const memberId = uuidv7();
    await db.insert(schema.member).values({
      id: memberId,
      organizationId: orgId,
      userId,
      role: "member",
      createdAt: new Date(),
    });
    await auditScim(db, orgId, "scim.provisioned", memberId);
  }

  if (isNew) {
    const delayMin = Number(env.SCIM_WELCOME_DELAY_MIN ?? "5") || 5;
    await db.insert(schema.pendingEmail).values({
      id: uuidv7(),
      kind: "scim_set_password",
      userId,
      orgId,
      sendAfter: new Date(Date.now() + delayMin * 60_000),
      sentAt: null,
      createdAt: new Date(),
    });
  }

  return {
    id: userId,
    userName: email,
    givenName: splitName(name).given,
    familyName: splitName(name).family,
    active: true,
  };
}

/** Suspend (active:false) or reactivate (active:true) the org membership. Suspend revokes sessions. */
export async function scimSetActive(
  env: ScimEnv,
  orgId: string,
  userId: string,
  active: boolean,
): Promise<ScimUser | null> {
  const db = buildDb(env.DB);
  const [m] = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(
      and(eq(schema.member.userId, userId), eq(schema.member.organizationId, orgId)),
    )
    .limit(1);
  if (!m) return null;
  if (active) {
    await db
      .update(schema.member)
      .set({ status: "active" })
      .where(eq(schema.member.id, m.id));
    await auditScim(db, orgId, "scim.reactivated", m.id);
  } else {
    await db
      .update(schema.member)
      .set({ status: "suspended" })
      .where(eq(schema.member.id, m.id));
    // Revoke sessions so the suspension is effective immediately (mirrors setMemberStatus).
    await db.delete(schema.session).where(eq(schema.session.userId, userId));
    await auditScim(db, orgId, "scim.suspended", m.id);
  }
  return scimGetUser(env, orgId, userId);
}

/** Update a user's profile (name/email) within this org. */
export async function scimUpdateUser(
  env: ScimEnv,
  orgId: string,
  userId: string,
  patch: {
    givenName?: string | null;
    familyName?: string | null;
    userName?: string | null;
    active?: boolean;
  },
): Promise<ScimUser | null> {
  const current = await scimGetUser(env, orgId, userId);
  if (!current) return null;
  const db = buildDb(env.DB);

  const set: { name?: string; email?: string } = {};
  if (patch.givenName !== undefined || patch.familyName !== undefined) {
    const given = patch.givenName ?? current.givenName ?? "";
    const family = patch.familyName ?? current.familyName ?? "";
    set.name = [given, family].filter(Boolean).join(" ").trim() || current.userName;
  }
  if (patch.userName) set.email = patch.userName.trim().toLowerCase();
  if (set.name || set.email) {
    await db.update(schema.user).set(set).where(eq(schema.user.id, userId));
  }
  if (patch.active !== undefined) {
    await scimSetActive(env, orgId, userId, patch.active);
  }
  return scimGetUser(env, orgId, userId);
}

/** Remove the org membership (keeps the account + history). */
export async function scimDeleteUser(
  env: ScimEnv,
  orgId: string,
  userId: string,
): Promise<boolean> {
  const db = buildDb(env.DB);
  const [m] = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(
      and(eq(schema.member.userId, userId), eq(schema.member.organizationId, orgId)),
    )
    .limit(1);
  if (!m) return false;
  await db.delete(schema.member).where(eq(schema.member.id, m.id));
  await db.delete(schema.session).where(eq(schema.session.userId, userId));
  await auditScim(db, orgId, "scim.deprovisioned", m.id);
  return true;
}
