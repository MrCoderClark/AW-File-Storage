import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { buildDb } from "../src/server/db";
import { files, organization, user } from "../src/server/db/schema";
import { orgDb } from "../src/server/org-db";
import {
  type ActorCtx,
  decodeCursor,
  encodeCursor,
  listFilesPage,
  type UploadEnv,
} from "../src/server/uploads";

const db = buildDb(env.DB);
const ENV = { DB: env.DB } as unknown as UploadEnv;
const CTX: ActorCtx = { orgId: "org-a", userId: "user-x", canManageAny: true };

// listFilesPage only reads; a minimal env with DB is enough. Explicit ids keep
// the default "new" sort (id desc) deterministic: f5 > f4 > … > f1.
async function insertFile(
  orgId: string,
  over: {
    id: string;
    name?: string;
    size?: number;
    kind?: "vcard" | "other";
    status?: "pending" | "uploading" | "validating" | "ready" | "failed";
    category?: string;
    contactName?: string | null;
    contactOrg?: string | null;
    contactLocation?: string | null;
    updatedAt?: Date;
  },
) {
  const now = new Date();
  await db.insert(files).values({
    id: over.id,
    orgId,
    uploadedBy: "user-x",
    originalName: over.name ?? `${over.id}.vcf`,
    contentType: "text/vcard",
    sizeBytes: over.size ?? 100,
    checksumSha256: `${orgId}-${over.id}`, // unique within (org, checksum)
    storageKey: `files/${over.id}`,
    bucket: "private",
    visibility: "private",
    kind: over.kind ?? "vcard",
    status: over.status ?? "ready",
    category: over.category ?? "vcard",
    contactName: over.contactName ?? null,
    contactOrg: over.contactOrg ?? null,
    contactLocation: over.contactLocation ?? null,
    createdAt: now,
    updatedAt: over.updatedAt ?? now,
  });
}

beforeEach(async () => {
  await db.delete(files);
  await db.delete(organization);
  await db.delete(user);
  await db.insert(user).values({
    id: "user-x",
    name: "Test User",
    email: "user-x@example.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(organization).values([
    { id: "org-a", name: "Org A", slug: "org-a", createdAt: new Date() },
    { id: "org-b", name: "Org B", slug: "org-b", createdAt: new Date() },
  ]);
});

describe("cursor encode/decode", () => {
  it("round-trips a string sort value", () => {
    const c = encodeCursor("Acme", "f3");
    expect(decodeCursor(c)).toEqual({ sortValue: "Acme", id: "f3" });
  });
  it("round-trips a numeric sort value", () => {
    const c = encodeCursor(1024, "f7");
    expect(decodeCursor(c)).toEqual({ sortValue: 1024, id: "f7" });
  });
  it("returns null for garbage", () => {
    expect(decodeCursor("not-a-cursor")).toBeNull();
  });
});

describe("listFilesPage (spec 0003/0007)", () => {
  async function seedFive() {
    for (const id of ["f1", "f2", "f3", "f4", "f5"]) {
      await insertFile("org-a", { id });
    }
  }

  it("returns one page plus a nextCursor, and clears it on the last page", async () => {
    await seedFive();
    const p1 = await listFilesPage(ENV, CTX, { limit: 2 });
    expect(p1.items.map((f) => f.id)).toEqual(["f5", "f4"]);
    expect(p1.nextCursor).not.toBeNull();

    const p2 = await listFilesPage(ENV, CTX, { limit: 2, cursor: p1.nextCursor });
    expect(p2.items.map((f) => f.id)).toEqual(["f3", "f2"]);

    const p3 = await listFilesPage(ENV, CTX, { limit: 2, cursor: p2.nextCursor });
    expect(p3.items.map((f) => f.id)).toEqual(["f1"]);
    expect(p3.nextCursor).toBeNull();
  });

  it("keyset pagination is stable when a row is deleted between pages", async () => {
    await seedFive();
    const p1 = await listFilesPage(ENV, CTX, { limit: 2 }); // [f5, f4]
    // Delete an already-seen row; with OFFSET this would skip f3. Keyset must not.
    await orgDb("org-a", db).files.softDelete("f5", "user-x");
    const p2 = await listFilesPage(ENV, CTX, { limit: 2, cursor: p1.nextCursor });
    expect(p2.items.map((f) => f.id)).toEqual(["f3", "f2"]); // no skip
  });

  it("sorts by name ascending and size descending", async () => {
    await insertFile("org-a", { id: "f1", name: "banana.vcf", size: 300 });
    await insertFile("org-a", { id: "f2", name: "apple.vcf", size: 100 });
    await insertFile("org-a", { id: "f3", name: "cherry.vcf", size: 200 });

    const byName = await listFilesPage(ENV, CTX, { sort: "name", dir: "asc" });
    expect(byName.items.map((f) => f.name)).toEqual([
      "apple.vcf",
      "banana.vcf",
      "cherry.vcf",
    ]);

    const bySize = await listFilesPage(ENV, CTX, { sort: "size", dir: "desc" });
    expect(bySize.items.map((f) => f.sizeBytes)).toEqual([300, 200, 100]);
  });

  it("searches the card's own content but NOT the uploader name", async () => {
    await insertFile("org-a", { id: "f1", contactOrg: "Acme Corporation" });
    await insertFile("org-a", { id: "f2", contactOrg: "Globex" });

    const acme = await listFilesPage(ENV, CTX, { q: "acme" });
    expect(acme.items.map((f) => f.id)).toEqual(["f1"]);

    // The uploader is "Test User", but searching it matches nothing: an uploader
    // match would flood results when one admin uploads every card (the "clark"
    // bug). Free-text search is scoped to the card's content only.
    const byUploader = await listFilesPage(ENV, CTX, { q: "test user" });
    expect(byUploader.items).toHaveLength(0);
  });

  it("searches the location blob by city or either state form", async () => {
    await insertFile("org-a", { id: "f1", contactLocation: "Bronx NY New York" });
    await insertFile("org-a", { id: "f2", contactLocation: "Austin TX Texas" });

    for (const q of ["Bronx", "NY", "New York"]) {
      const page = await listFilesPage(ENV, CTX, { q });
      expect(page.items.map((f) => f.id)).toEqual(["f1"]);
    }
    const tx = await listFilesPage(ENV, CTX, { q: "Texas" });
    expect(tx.items.map((f) => f.id)).toEqual(["f2"]);
  });

  it("filters by category and status", async () => {
    await insertFile("org-a", { id: "f1", category: "vcard" });
    await insertFile("org-a", {
      id: "f2",
      kind: "other",
      category: "pdf",
      status: "failed",
    });

    const pdfs = await listFilesPage(ENV, CTX, { category: "pdf" });
    expect(pdfs.items.map((f) => f.id)).toEqual(["f2"]);

    const failed = await listFilesPage(ENV, CTX, { status: "failed" });
    expect(failed.items.map((f) => f.id)).toEqual(["f2"]);
  });

  it("is org-scoped — org-b's files never appear for org-a", async () => {
    await insertFile("org-a", { id: "a1", contactOrg: "Acme" });
    await insertFile("org-b", { id: "b1", contactOrg: "Acme" });
    const page = await listFilesPage(ENV, CTX, { q: "acme" });
    expect(page.items.map((f) => f.id)).toEqual(["a1"]);
  });

  it("excludes soft-deleted files", async () => {
    await insertFile("org-a", { id: "f1" });
    await insertFile("org-a", { id: "f2" });
    await orgDb("org-a", db).files.softDelete("f1", "user-x");
    const page = await listFilesPage(ENV, CTX, {});
    expect(page.items.map((f) => f.id)).toEqual(["f2"]);
  });
});
