import { env } from "cloudflare:test";
import { and, eq, isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Graph client (directory listing + attribute writes) and R2 network I/O,
// so no real Microsoft/R2 calls happen. The DB, the per-org credential load
// (org_o365, KEK-decrypted), the toggles, the domain map, and the whole publish +
// offboard logic stay real (spec 0016).
vi.mock("../src/server/graph", async (orig) => {
  const actual = (await orig()) as object;
  return {
    ...actual,
    listDirectoryUsers: vi.fn(),
    listDeletedUsers: vi.fn(),
    graphUserExists: vi.fn(),
    findUsersByEmail: vi.fn(),
    patchUserExtensionAttribute1: vi.fn(),
    getUserExtensionAttribute1: vi.fn(),
  };
});
vi.mock("../src/server/r2", async (orig) => {
  const actual = (await orig()) as object;
  return {
    ...actual,
    r2Put: vi.fn().mockResolvedValue(undefined),
    r2Delete: vi.fn().mockResolvedValue(undefined),
  };
});

import { buildDb } from "../src/server/db";
import {
  files,
  member,
  orgDomains,
  organization,
  orgSettings,
  user,
} from "../src/server/db/schema";
import type { GraphDirectoryUser } from "../src/server/graph";
import * as graph from "../src/server/graph";
import {
  type O365ProvisionEnv,
  provisionCardsForOrg,
} from "../src/server/o365-provision";
import { orgDb } from "../src/server/org-db";
import { encryptSecret } from "../src/server/secret-box";
import { purgeOffboardedCards } from "../src/server/uploads";

const db = buildDb(env.DB);
const KEK = btoa("0123456789abcdef0123456789abcdef");

const BASE_ENV = {
  DB: env.DB,
  PUBLIC_FILE_DOMAIN: "contacts.awvcard.com",
  O365_CRED_KEK: KEK,
  R2_ACCOUNT_ID: "acct",
  R2_ACCESS_KEY_ID: "key",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_PRIVATE_BUCKET: "private",
  R2_PUBLIC_BUCKET: "public",
} as unknown as O365ProvisionEnv;

const listUsers = vi.mocked(graph.listDirectoryUsers);
const listDeleted = vi.mocked(graph.listDeletedUsers);
const userExists = vi.mocked(graph.graphUserExists);
const findUsers = vi.mocked(graph.findUsersByEmail);
const patchAttr = vi.mocked(graph.patchUserExtensionAttribute1);

/** A directory user with sensible defaults (enabled + licensed + mailboxed). */
function dirUser(over: Partial<GraphDirectoryUser>): GraphDirectoryUser {
  return {
    id: "u1",
    accountEnabled: true,
    licensed: true,
    mail: "jane@aw.com",
    userPrincipalName: "jane@aw.com",
    displayName: "Jane Doe",
    givenName: "Jane",
    surname: "Doe",
    jobTitle: "Engineer",
    mobilePhone: "212-555-1212",
    businessPhones: ["212-555-3434"],
    streetAddress: "1 Main St",
    city: "Bronx",
    state: "NY",
    postalCode: "10001",
    country: "USA",
    companyName: "AW",
    department: "Eng",
    // Default: created just after the toggle's cutoff (set in beforeEach), so a
    // fixture user counts as "new" unless a test overrides this.
    createdDateTime: new Date(Date.now() + 60_000),
    currentAttr: null,
    ...over,
  };
}

async function connect(orgId: string) {
  const sealed = await encryptSecret(KEK, `${orgId}-secret`);
  await orgDb(orgId, db).graphCreds.set({
    tenantId: `${orgId}-tenant`,
    clientId: `${orgId}-client`,
    authMethod: "secret",
    secretCt: sealed.ct,
    secretIv: sealed.iv,
    certKeyCt: null,
    certKeyIv: null,
    certThumbprint: null,
    lastVerifiedAt: new Date(),
  });
}

const liveVcards = (orgId: string) =>
  db
    .select()
    .from(files)
    .where(
      and(
        eq(files.orgId, orgId),
        eq(files.kind, "vcard"),
        eq(files.visibility, "public"),
        isNull(files.deletedAt),
      ),
    );

/** Insert a pre-existing card (manual or auto) directly. */
async function insertCard(over: {
  id: string;
  orgId?: string;
  email: string;
  source?: string;
  o365UserId?: string | null;
  o365SyncedUrl?: string | null;
  visibility?: "private" | "public";
  offboardedAt?: Date | null;
}) {
  const now = new Date();
  await db.insert(files).values({
    id: over.id,
    orgId: over.orgId ?? "org-a",
    uploadedBy: "owner-a",
    originalName: `${over.id}.vcf`,
    contentType: "text/vcard",
    sizeBytes: 100,
    checksumSha256: `${over.id}-sum`,
    storageKey: `files/${over.id}`,
    bucket: "private",
    visibility: over.visibility ?? "public",
    kind: "vcard",
    status: "ready",
    publicSlug: over.id,
    contactEmail: over.email,
    source: over.source ?? "manual",
    o365UserId: over.o365UserId ?? null,
    o365SyncedUrl: over.o365SyncedUrl ?? null,
    offboardedAt: over.offboardedAt ?? null,
    createdAt: now,
    updatedAt: now,
  });
}

const enableOffboard = () =>
  orgDb("org-a", db).settings.setO365RemoveOnOffboardEnabled(true);

beforeEach(async () => {
  listUsers.mockReset();
  listDeleted.mockReset();
  listDeleted.mockResolvedValue([]); // no deletions unless a test says so
  userExists.mockReset();
  userExists.mockResolvedValue(true); // users exist unless a test says otherwise
  findUsers.mockReset();
  patchAttr.mockReset();
  // syncCardToO365 matches the new card by email; return the same directory user.
  findUsers.mockImplementation(async (_c, email) => [
    { id: "u1", mail: email, userPrincipalName: email, currentAttr: null },
  ]);

  await db.delete(files);
  await db.delete(orgDomains);
  await db.delete(member);
  await db.delete(orgSettings);
  await db.delete(organization);
  await db.delete(user);
  await db.insert(user).values({
    id: "owner-a", name: "Owner", email: "owner@aw.com", emailVerified: true,
    createdAt: new Date(), updatedAt: new Date(),
  });
  await db.insert(organization).values({
    id: "org-a", name: "A", slug: "org-a", createdAt: new Date(),
  });
  await db.insert(member).values({
    id: "m-owner-a", organizationId: "org-a", userId: "owner-a",
    role: "owner", status: "active", createdAt: new Date(),
  });
  await db.insert(orgDomains).values({
    id: "d-a", orgId: "org-a", domain: "aw.com", source: "manual",
    createdAt: new Date(),
  });
  // Opted in: both toggles on + connected.
  await orgDb("org-a", db).settings.setO365SyncEnabled(true);
  await orgDb("org-a", db).settings.setO365AutoCardEnabled(true);
  await connect("org-a");
});

describe("provisionCardsForOrg — create pass (spec 0016)", () => {
  it("creates + publishes a card for an in-scope user and writes CustomAttribute1", async () => {
    listUsers.mockResolvedValue([dirUser({})]);
    const s = await provisionCardsForOrg(BASE_ENV, "org-a");
    expect(s.created).toBe(1);

    const cards = await liveVcards("org-a");
    expect(cards).toHaveLength(1);
    expect(cards[0].source).toBe("o365_auto");
    expect(cards[0].o365UserId).toBe("u1");
    expect(cards[0].contactEmail).toBe("jane@aw.com");
    // The URL was written into the user's attribute.
    expect(patchAttr).toHaveBeenCalledWith(
      expect.anything(),
      "u1",
      expect.stringContaining("/c/"),
    );
  });

  it("skips an existing user created before the feature was enabled (no backfill)", async () => {
    listUsers.mockResolvedValue([
      dirUser({ createdDateTime: new Date(Date.now() - 60_000) }),
    ]);
    const s = await provisionCardsForOrg(BASE_ENV, "org-a");
    expect(s.created).toBe(0);
    expect(await liveVcards("org-a")).toHaveLength(0);
  });

  it("skips a user whose mailbox is not ready (no mail) — retried later", async () => {
    listUsers.mockResolvedValue([dirUser({ mail: null })]);
    const s = await provisionCardsForOrg(BASE_ENV, "org-a");
    expect(s.created).toBe(0);
    expect(await liveVcards("org-a")).toHaveLength(0);
  });

  it("skips disabled and unlicensed users", async () => {
    listUsers.mockResolvedValue([
      dirUser({ id: "u2", mail: "a@aw.com", accountEnabled: false }),
      dirUser({ id: "u3", mail: "b@aw.com", licensed: false }),
    ]);
    const s = await provisionCardsForOrg(BASE_ENV, "org-a");
    expect(s.created).toBe(0);
    expect(await liveVcards("org-a")).toHaveLength(0);
  });

  it("skips a user whose email domain does not belong to this org", async () => {
    listUsers.mockResolvedValue([dirUser({ mail: "bob@other.com" })]);
    const s = await provisionCardsForOrg(BASE_ENV, "org-a");
    expect(s.created).toBe(0);
    expect(await liveVcards("org-a")).toHaveLength(0);
  });

  it("does not duplicate or clobber an existing card for the same email", async () => {
    await insertCard({ id: "manual1", email: "jane@aw.com", source: "manual" });
    listUsers.mockResolvedValue([dirUser({})]);
    const s = await provisionCardsForOrg(BASE_ENV, "org-a");
    expect(s.created).toBe(0);
    const cards = await liveVcards("org-a");
    expect(cards).toHaveLength(1);
    expect(cards[0].source).toBe("manual"); // untouched
  });

  it("is a no-op when the auto-card toggle is off", async () => {
    await orgDb("org-a", db).settings.setO365AutoCardEnabled(false);
    listUsers.mockResolvedValue([dirUser({})]);
    const s = await provisionCardsForOrg(BASE_ENV, "org-a");
    expect(s.created).toBe(0);
    expect(listUsers).not.toHaveBeenCalled();
  });
});

describe("provisionCardsForOrg — offboard pass (spec 0017)", () => {
  // A disabled + unlicensed user still present in the directory.
  const offboarded = (over = {}) =>
    dirUser({ accountEnabled: false, licensed: false, ...over });

  it("retracts a MANUAL card for a disabled+unlicensed user on the O365 domain", async () => {
    await enableOffboard();
    // A manual card that the spec-0010 reconcile previously synced (so it has the
    // matched user id + a written URL — that's why CustomAttribute1 can be cleared).
    await insertCard({
      id: "manual1", email: "gone@aw.com", source: "manual",
      o365UserId: "u9",
      o365SyncedUrl: "https://contacts.awvcard.com/c/manual1.vcf",
    });
    listUsers.mockResolvedValue([offboarded({ id: "u9", mail: "gone@aw.com" })]);
    const s = await provisionCardsForOrg(BASE_ENV, "org-a");
    expect(s.unpublished).toBe(1);
    const [card] = await db.select().from(files).where(eq(files.id, "manual1"));
    expect(card.visibility).toBe("private");
    expect(card.offboardedAt).toBeTruthy();
    expect(patchAttr).toHaveBeenCalledWith(expect.anything(), "u9", null); // cleared
  });

  it("does nothing when the remove-on-offboard toggle is off", async () => {
    // (auto-card is on from beforeEach, but the offboard toggle is not)
    await insertCard({ id: "manual1", email: "gone@aw.com", source: "manual" });
    listUsers.mockResolvedValue([offboarded({ id: "u9", mail: "gone@aw.com" })]);
    const s = await provisionCardsForOrg(BASE_ENV, "org-a");
    expect(s.unpublished).toBe(0);
    const [card] = await db.select().from(files).where(eq(files.id, "manual1"));
    expect(card.visibility).toBe("public");
  });

  it("leaves a disabled-but-LICENSED user's card alone (not fully offboarded)", async () => {
    await enableOffboard();
    await insertCard({ id: "manual1", email: "gone@aw.com", source: "manual" });
    listUsers.mockResolvedValue([
      dirUser({ id: "u9", mail: "gone@aw.com", accountEnabled: false, licensed: true }),
    ]);
    const s = await provisionCardsForOrg(BASE_ENV, "org-a");
    expect(s.unpublished).toBe(0);
    expect((await db.select().from(files).where(eq(files.id, "manual1")))[0].visibility).toBe("public");
  });

  it("retracts a card for a HARD-DELETED user, matched by stored user id (spec 0019)", async () => {
    await enableOffboard();
    await insertCard({
      id: "auto1", email: "angelina@aw.com", source: "o365_auto", o365UserId: "udel",
      o365SyncedUrl: "https://contacts.awvcard.com/c/auto1.vcf",
    });
    listUsers.mockResolvedValue([]); // gone from the active directory
    // In the recycle bin; mail is null (mangled), so only the id matches.
    listDeleted.mockResolvedValue([{ id: "udel", mail: null }]);
    const s = await provisionCardsForOrg(BASE_ENV, "org-a");
    expect(s.unpublished).toBe(1);
    const [card] = await db.select().from(files).where(eq(files.id, "auto1"));
    expect(card.visibility).toBe("private");
    expect(card.offboardedAt).toBeTruthy();
    expect(patchAttr).toHaveBeenCalledWith(expect.anything(), "udel", null);
  });

  it("skips hard-delete detection when deletedItems is unavailable (no crash)", async () => {
    await enableOffboard();
    await insertCard({ id: "auto1", email: "gone@aw.com", source: "o365_auto", o365UserId: "udel" });
    listUsers.mockResolvedValue([]);
    listDeleted.mockRejectedValue(new Error("403 Forbidden")); // missing permission
    const s = await provisionCardsForOrg(BASE_ENV, "org-a");
    expect(s.unpublished).toBe(0); // couldn't detect the deletion, but didn't throw
    expect((await db.select().from(files).where(eq(files.id, "auto1")))[0].visibility).toBe("public");
  });

  it("DELETES a card for a PERMANENTLY-deleted user (404 + confirmed not in recycle bin, spec 0019)", async () => {
    await enableOffboard();
    await insertCard({
      id: "auto1", email: "purged@aw.com", source: "o365_auto", o365UserId: "upurged",
    });
    listUsers.mockResolvedValue([]); // not in the active directory
    listDeleted.mockResolvedValue([]); // recycle-bin read OK, and NOT in it → permanent
    userExists.mockResolvedValue(false); // GET /users/{id} → 404: provably gone
    const s = await provisionCardsForOrg(BASE_ENV, "org-a");
    expect(s.deleted).toBe(1); // deleted, not just retracted
    expect(s.unpublished).toBe(0);
    const [card] = await db.select().from(files).where(eq(files.id, "auto1"));
    expect(card.deletedAt).toBeTruthy(); // hard-deleted — no 30-day grace
  });

  it("only RETRACTS (grace) a gone user when the recycle-bin read failed — can't confirm permanent", async () => {
    await enableOffboard();
    await insertCard({
      id: "auto1", email: "gone@aw.com", source: "o365_auto", o365UserId: "ugone",
    });
    listUsers.mockResolvedValue([]);
    listDeleted.mockRejectedValue(new Error("403")); // can't read recycle bin
    userExists.mockResolvedValue(false); // the user is gone, but soft vs permanent is unknown
    const s = await provisionCardsForOrg(BASE_ENV, "org-a");
    expect(s.deleted).toBe(0);
    expect(s.unpublished).toBe(1); // retracted with the 30-day grace, not deleted
    const [card] = await db.select().from(files).where(eq(files.id, "auto1"));
    expect(card.visibility).toBe("private");
    expect(card.deletedAt).toBeNull();
    expect(card.offboardedAt).toBeTruthy();
  });

  it("does NOT retract on a transient listing gap — the user still exists on lookup", async () => {
    await enableOffboard();
    await insertCard({ id: "auto1", email: "present@aw.com", source: "o365_auto", o365UserId: "upresent" });
    listUsers.mockResolvedValue([]); // momentarily missing from the listing (glitch)
    listDeleted.mockResolvedValue([]);
    userExists.mockResolvedValue(true); // but the direct lookup finds them — not gone
    const s = await provisionCardsForOrg(BASE_ENV, "org-a");
    expect(s.unpublished).toBe(0);
    expect((await db.select().from(files).where(eq(files.id, "auto1")))[0].visibility).toBe("public");
  });

  it("never treats an ABSENT user as offboarded (positive signal only)", async () => {
    await enableOffboard();
    await insertCard({ id: "manual1", email: "gone@aw.com", source: "manual" });
    listUsers.mockResolvedValue([]); // the user is missing from the listing
    const s = await provisionCardsForOrg(BASE_ENV, "org-a");
    expect(s.unpublished).toBe(0);
    expect((await db.select().from(files).where(eq(files.id, "manual1")))[0].visibility).toBe("public");
  });

  it("never touches a card on a non-O365 domain", async () => {
    await enableOffboard();
    await insertCard({ id: "ext1", email: "gone@other.com", source: "manual" });
    listUsers.mockResolvedValue([offboarded({ id: "u9", mail: "gone@other.com" })]);
    const s = await provisionCardsForOrg(BASE_ENV, "org-a");
    expect(s.unpublished).toBe(0);
    expect((await db.select().from(files).where(eq(files.id, "ext1")))[0].visibility).toBe("public");
  });
});

describe("purgeOffboardedCards — 30-day delete (spec 0017)", () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

  it("deletes cards past 30 days, spares recent and re-published ones", async () => {
    await insertCard({ id: "old", email: "a@aw.com", visibility: "private", offboardedAt: daysAgo(31) });
    await insertCard({ id: "recent", email: "b@aw.com", visibility: "private", offboardedAt: daysAgo(10) });
    await insertCard({ id: "republished", email: "c@aw.com", visibility: "public", offboardedAt: daysAgo(31) });
    const { deleted } = await purgeOffboardedCards(BASE_ENV);
    expect(deleted).toBe(1);
    expect((await db.select().from(files).where(eq(files.id, "old")))[0].deletedAt).toBeTruthy();
    expect((await db.select().from(files).where(eq(files.id, "recent")))[0].deletedAt).toBeNull();
    expect((await db.select().from(files).where(eq(files.id, "republished")))[0].deletedAt).toBeNull();
  });
});
