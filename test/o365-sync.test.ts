import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Graph client so no real Microsoft Graph calls happen. The per-org
// credential load (org_o365, decrypted with the KEK) and the o365SyncEnabled
// toggle (org_settings) stay real, so the per-org connect/isolation logic is
// tested (spec 0012/0013).
vi.mock("../src/server/graph", async (orig) => {
  const actual = (await orig()) as object;
  return {
    ...actual,
    findUsersByEmail: vi.fn(),
    patchUserExtensionAttribute1: vi.fn(),
    getUserExtensionAttribute1: vi.fn(),
  };
});

import { buildDb } from "../src/server/db";
import { files, organization, orgO365, orgSettings, user } from "../src/server/db/schema";
import * as graph from "../src/server/graph";
import { syncCardToO365, type O365SyncEnv } from "../src/server/o365-sync";
import { orgDb } from "../src/server/org-db";
import { encryptSecret } from "../src/server/secret-box";

const db = buildDb(env.DB);

// A fixed base64 32-byte KEK for the test; the sync decrypts each org's creds with it.
const KEK = btoa("0123456789abcdef0123456789abcdef");

// The KEK is present (so creds CAN be decrypted); each org still needs its OWN
// credentials row + toggle on (spec 0013). Graph calls are mocked, so the tenant/
// secret values here are never actually used against Microsoft.
const BASE_ENV = {
  DB: env.DB,
  PUBLIC_FILE_DOMAIN: "contacts.awvcard.com",
  O365_CRED_KEK: KEK,
} as unknown as O365SyncEnv;

/** Give an org its own (encrypted) client-secret credentials — "connected". */
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

const findUsers = vi.mocked(graph.findUsersByEmail);
const patchAttr = vi.mocked(graph.patchUserExtensionAttribute1);

async function insertCard(over: {
  id: string;
  orgId?: string;
  slug?: string | null;
  visibility?: "private" | "public";
  deleted?: boolean;
  email?: string | null;
  o365UserId?: string | null;
  o365SyncedUrl?: string | null;
}) {
  const now = new Date();
  await db.insert(files).values({
    id: over.id,
    orgId: over.orgId ?? "org-a",
    uploadedBy: "user-x",
    originalName: `${over.id}.vcf`,
    contentType: "text/vcard",
    sizeBytes: 100,
    checksumSha256: `${over.id}-sum`,
    storageKey: `files/${over.id}`,
    bucket: over.visibility === "public" ? "public" : "private",
    visibility: over.visibility ?? "public",
    kind: "vcard",
    status: "ready",
    publicSlug: over.slug === undefined ? over.id : over.slug,
    contactEmail: over.email === undefined ? "jane@aw.com" : over.email,
    o365UserId: over.o365UserId ?? null,
    o365SyncedUrl: over.o365SyncedUrl ?? null,
    createdAt: now,
    updatedAt: now,
    deletedAt: over.deleted ? now : null,
  });
}

async function readState(id: string) {
  const [row] = await db
    .select({
      status: files.o365SyncStatus,
      userId: files.o365UserId,
      url: files.o365SyncedUrl,
    })
    .from(files)
    .where(eq(files.id, id));
  return row;
}

beforeEach(async () => {
  findUsers.mockReset();
  patchAttr.mockReset();
  await db.delete(files);
  await db.delete(orgO365);
  await db.delete(orgSettings);
  await db.delete(organization);
  await db.delete(user);
  await db.insert(user).values({
    id: "user-x", name: "X", email: "x@e.com", emailVerified: true,
    createdAt: new Date(), updatedAt: new Date(),
  });
  await db.insert(organization).values([
    { id: "org-a", name: "A", slug: "org-a", createdAt: new Date() },
    { id: "org-b", name: "B", slug: "org-b", createdAt: new Date() },
  ]);
  // org-a is fully connected (toggle on + its own creds); org-b is neither, until
  // a test opts it in. Most tests use org-a.
  await orgDb("org-a", db).settings.setO365SyncEnabled(true);
  await connect("org-a");
});

describe("syncCardToO365", () => {
  it("no-ops (no Graph calls) when the org's toggle is off (AC-7)", async () => {
    await insertCard({ id: "f1" });
    await orgDb("org-a", db).settings.setO365SyncEnabled(false); // turn org-a off
    await syncCardToO365(BASE_ENV, "f1");
    expect(findUsers).not.toHaveBeenCalled();
    expect(patchAttr).not.toHaveBeenCalled();
    expect((await readState("f1")).status).toBeNull();
  });

  it("syncs only cards whose OWN org is connected (per-org, spec 0012/0013)", async () => {
    // org-a is connected (beforeEach); org-b is not. A card in org-b must not sync
    // even though org-a is — one org's connection never reaches another's cards.
    await insertCard({ id: "fb", orgId: "org-b", slug: "Bee", email: "bee@aw.com" });
    findUsers.mockResolvedValue([
      { id: "u9", mail: "bee@aw.com", userPrincipalName: "bee@aw.com", currentAttr: null },
    ]);
    await syncCardToO365(BASE_ENV, "fb");
    expect(findUsers).not.toHaveBeenCalled();
    expect(patchAttr).not.toHaveBeenCalled();
    expect((await readState("fb")).status).toBeNull();

    // Connecting org-b (toggle on + its own creds) lets its card sync.
    await orgDb("org-b", db).settings.setO365SyncEnabled(true);
    await connect("org-b");
    await syncCardToO365(BASE_ENV, "fb");
    expect(patchAttr).toHaveBeenCalledWith(
      expect.anything(), "u9", "https://contacts.awvcard.com/c/Bee.vcf",
    );
    expect((await readState("fb")).status).toBe("synced");
  });

  it("no-ops when the org has the toggle on but NO credentials (spec 0013 AC-4)", async () => {
    // org-a's toggle is on (beforeEach) but clear its credentials.
    await orgDb("org-a", db).graphCreds.clear();
    await insertCard({ id: "f1", slug: "Jane_Doe", email: "jane@aw.com" });
    findUsers.mockResolvedValue([
      { id: "u1", mail: "jane@aw.com", userPrincipalName: "jane@aw.com", currentAttr: null },
    ]);
    await syncCardToO365(BASE_ENV, "f1");
    expect(findUsers).not.toHaveBeenCalled();
    expect(patchAttr).not.toHaveBeenCalled();
    expect((await readState("f1")).status).toBeNull();
  });

  it("writes the card URL for a single email match (AC-1, AC-6)", async () => {
    await insertCard({ id: "f1", slug: "Jane_Doe", email: "jane@aw.com" });
    findUsers.mockResolvedValue([
      { id: "u1", mail: "jane@aw.com", userPrincipalName: "jane@aw.com", currentAttr: null },
    ]);
    await syncCardToO365(BASE_ENV, "f1");
    expect(patchAttr).toHaveBeenCalledWith(
      expect.anything(), "u1", "https://contacts.awvcard.com/c/Jane_Doe.vcf",
    );
    const s = await readState("f1");
    expect(s).toMatchObject({
      status: "synced", userId: "u1",
      url: "https://contacts.awvcard.com/c/Jane_Doe.vcf",
    });
  });

  it("does not PATCH when the attribute already matches (idempotent, AC-2)", async () => {
    await insertCard({ id: "f1", slug: "Jane_Doe" });
    findUsers.mockResolvedValue([
      {
        id: "u1", mail: "jane@aw.com", userPrincipalName: "jane@aw.com",
        currentAttr: "https://contacts.awvcard.com/c/Jane_Doe.vcf",
      },
    ]);
    await syncCardToO365(BASE_ENV, "f1");
    expect(patchAttr).not.toHaveBeenCalled();
    expect((await readState("f1")).status).toBe("synced");
  });

  it("records no_match / ambiguous without writing (AC-5)", async () => {
    await insertCard({ id: "f1" });
    findUsers.mockResolvedValue([]);
    await syncCardToO365(BASE_ENV, "f1");
    expect(patchAttr).not.toHaveBeenCalled();
    expect((await readState("f1")).status).toBe("no_match");

    await insertCard({ id: "f2" });
    findUsers.mockResolvedValue([
      { id: "u1", mail: "a", userPrincipalName: "a", currentAttr: null },
      { id: "u2", mail: "b", userPrincipalName: "b", currentAttr: null },
    ]);
    await syncCardToO365(BASE_ENV, "f2");
    expect((await readState("f2")).status).toBe("ambiguous");
  });

  it("clears the attribute when the card is not live (unpublish/delete, AC-3)", async () => {
    await insertCard({
      id: "f1", visibility: "private",
      o365UserId: "u1", o365SyncedUrl: "https://contacts.awvcard.com/c/Jane_Doe.vcf",
    });
    await syncCardToO365(BASE_ENV, "f1");
    expect(patchAttr).toHaveBeenCalledWith(expect.anything(), "u1", null);
    const s = await readState("f1");
    expect(s).toMatchObject({ status: "cleared", userId: null, url: null });
  });

  it("records an error when Graph throws, keeping prior state for retry", async () => {
    await insertCard({ id: "f1", slug: "Jane_Doe" });
    findUsers.mockRejectedValue(new Error("Graph 503"));
    await syncCardToO365(BASE_ENV, "f1");
    expect((await readState("f1")).status).toBe("error");
  });
});
