import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { buildDb } from "../src/server/db";
import { files, organization, user } from "../src/server/db/schema";
import { orgDb, OrgScopeError } from "../src/server/org-db";

const db = buildDb(env.DB);

function newFileInput(name: string, checksum: string) {
  return {
    uploadedBy: "user-x",
    originalName: name,
    contentType: "text/vcard",
    sizeBytes: 100,
    checksumSha256: checksum,
    storageKey: `files/${name}`,
    bucket: "private" as const,
    visibility: "private" as const,
    kind: "other" as const,
    status: "ready" as const,
  };
}

// The file FKs now reference Better Auth's user/organization tables, so those
// rows must exist before a file can be inserted. Seed them fresh each test.
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

describe("organization isolation (spec 0002)", () => {
  it("a scoped client sees only its own organization's files", async () => {
    // org-a has two files, org-b has one.
    await orgDb("org-a", db).files.create(newFileInput("a1.vcf", "aaa1"));
    await orgDb("org-a", db).files.create(newFileInput("a2.vcf", "aaa2"));
    await orgDb("org-b", db).files.create(newFileInput("b1.vcf", "bbb1"));

    const aFiles = await orgDb("org-a", db).files.listActive();
    const bFiles = await orgDb("org-b", db).files.listActive();

    expect(aFiles).toHaveLength(2);
    expect(aFiles.every((f) => f.orgId === "org-a")).toBe(true);
    expect(bFiles).toHaveLength(1);
    expect(bFiles[0].orgId).toBe("org-b");
  });

  it("cannot fetch another organization's file by id", async () => {
    const bFile = await orgDb("org-b", db).files.create(
      newFileInput("secret.vcf", "bbb2"),
    );

    // org-a asking for org-b's real id gets nothing (caller turns this into 404).
    const seenByA = await orgDb("org-a", db).files.get(bFile.id);
    expect(seenByA).toBeUndefined();

    // org-b can see its own.
    const seenByB = await orgDb("org-b", db).files.get(bFile.id);
    expect(seenByB?.id).toBe(bFile.id);
  });

  it("throws OrgScopeError when no organization is in scope", () => {
    expect(() => orgDb("", db)).toThrow(OrgScopeError);
    expect(() => orgDb("   ", db)).toThrow(OrgScopeError);
  });

  it("injects the organization on insert, ignoring anything the caller might pass", async () => {
    const created = await orgDb("org-a", db).files.create(
      newFileInput("a3.vcf", "aaa3"),
    );
    expect(created.orgId).toBe("org-a");
  });

  it("soft delete removes a file from listings but keeps the row", async () => {
    const f = await orgDb("org-a", db).files.create(
      newFileInput("gone.vcf", "aaa4"),
    );

    await orgDb("org-a", db).files.softDelete(f.id, "user-x");

    const listed = await orgDb("org-a", db).files.listActive();
    expect(listed).toHaveLength(0);

    // The row still exists and records who/when.
    const stillThere = await orgDb("org-a", db).files.get(f.id);
    expect(stillThere?.deletedAt).not.toBeNull();
    expect(stillThere?.deletedBy).toBe("user-x");
  });
});
