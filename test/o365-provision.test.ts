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
    createdAt: now,
    updatedAt: now,
  });
}

beforeEach(async () => {
  listUsers.mockReset();
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

describe("provisionCardsForOrg — offboard pass (spec 0016)", () => {
  it("unpublishes an auto card whose user is disabled, and clears the attribute", async () => {
    await insertCard({
      id: "auto1", email: "gone@aw.com", source: "o365_auto", o365UserId: "u9",
      o365SyncedUrl: "https://contacts.awvcard.com/c/auto1.vcf", // previously synced
    });
    // The directory no longer has an active u9 (disabled).
    listUsers.mockResolvedValue([
      dirUser({ id: "u9", mail: "gone@aw.com", accountEnabled: false }),
    ]);
    const s = await provisionCardsForOrg(BASE_ENV, "org-a");
    expect(s.unpublished).toBe(1);

    const [card] = await db.select().from(files).where(eq(files.id, "auto1"));
    expect(card.visibility).toBe("private");
    expect(patchAttr).toHaveBeenCalledWith(expect.anything(), "u9", null);
  });

  it("leaves a MANUAL card published even when its user is gone", async () => {
    await insertCard({
      id: "manual2", email: "gone@aw.com", source: "manual", o365UserId: "u9",
    });
    listUsers.mockResolvedValue([]); // u9 absent from the directory
    const s = await provisionCardsForOrg(BASE_ENV, "org-a");
    expect(s.unpublished).toBe(0);
    const [card] = await db.select().from(files).where(eq(files.id, "manual2"));
    expect(card.visibility).toBe("public");
  });
});
