import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Graph client so no real Microsoft Graph calls happen. graphConfigured /
// o365SyncEnabled stay real (they read env), so the enable/disable logic is tested.
vi.mock("../src/server/graph", async (orig) => {
  const actual = (await orig()) as object;
  return {
    ...actual,
    findUsersByEmail: vi.fn(),
    patchUserExtensionAttribute1: vi.fn(),
    getUserExtensionAttribute1: vi.fn(),
  };
});

import { setO365SyncEnabled } from "../src/server/app-settings";
import { buildDb } from "../src/server/db";
import { appSettings, files, organization, user } from "../src/server/db/schema";
import * as graph from "../src/server/graph";
import { syncCardToO365, type O365SyncEnv } from "../src/server/o365-sync";

const db = buildDb(env.DB);

// Credentials present (so graphConfigured is true); the on/off is the DB toggle.
const BASE_ENV = {
  DB: env.DB,
  PUBLIC_FILE_DOMAIN: "contacts.awvcard.com",
  GRAPH_TENANT_ID: "t",
  GRAPH_CLIENT_ID: "c",
  GRAPH_CLIENT_SECRET: "s",
} as unknown as O365SyncEnv;

const findUsers = vi.mocked(graph.findUsersByEmail);
const patchAttr = vi.mocked(graph.patchUserExtensionAttribute1);

async function insertCard(over: {
  id: string;
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
    orgId: "org-a",
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
  await db.delete(organization);
  await db.delete(user);
  await db.delete(appSettings);
  await db.insert(user).values({
    id: "user-x", name: "X", email: "x@e.com", emailVerified: true,
    createdAt: new Date(), updatedAt: new Date(),
  });
  await db.insert(organization).values({
    id: "org-a", name: "A", slug: "org-a", createdAt: new Date(),
  });
  // Enable the sync via the Settings toggle for most tests.
  await setO365SyncEnabled(BASE_ENV, true);
});

describe("syncCardToO365", () => {
  it("no-ops (no Graph calls) when the toggle is off (AC-7)", async () => {
    await insertCard({ id: "f1" });
    await setO365SyncEnabled(BASE_ENV, false); // turn the Settings toggle off
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
