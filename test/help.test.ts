import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { buildDb } from "../src/server/db";
import { organization, user } from "../src/server/db/auth-schema";
import { helpArticles, helpImages } from "../src/server/db/schema";
import { orgDb } from "../src/server/org-db";

// Isolation tests for the help CMS's ONE cross-org read (spec 0024 AC-4/AC-7/AC-10). The
// reader union (own-org published PLUS shared published) and the image-serve authorization
// are the only cross-org reads; everything else stays org-scoped. These prove org B's
// non-shared / draft content never leaks to org A, and that a shared published article's
// image is servable cross-org while a non-shared one is not.

const db = buildDb(env.DB);
const now = () => new Date();

async function seed() {
  await db.delete(helpImages);
  await db.delete(helpArticles);
  await db.delete(organization);
  await db.delete(user);

  await db.insert(user).values([
    { id: "u-a", name: "A", email: "a@x.com", emailVerified: true, createdAt: now(), updatedAt: now() },
    { id: "u-b", name: "B", email: "b@x.com", emailVerified: true, createdAt: now(), updatedAt: now() },
  ]);
  await db.insert(organization).values([
    { id: "org-a", name: "A", slug: "a", createdAt: now() },
    { id: "org-b", name: "B", slug: "b", createdAt: now() },
  ]);
  await db.insert(helpArticles).values([
    // org A: one published (own), one draft
    { id: "a-pub", orgId: "org-a", title: "A published", slug: "a-pub", category: "General", bodyHtml: "<p>a</p>", status: "published", shared: false, sortOrder: 0, createdAt: now(), updatedAt: now() },
    { id: "a-draft", orgId: "org-a", title: "A draft", slug: "a-draft", category: "General", bodyHtml: "<p>d</p>", status: "draft", shared: false, sortOrder: 1, createdAt: now(), updatedAt: now() },
    // org B: one published non-shared, one published shared
    { id: "b-pub", orgId: "org-b", title: "B published", slug: "b-pub", category: "General", bodyHtml: "<p>b</p>", status: "published", shared: false, sortOrder: 0, createdAt: now(), updatedAt: now() },
    { id: "b-shared", orgId: "org-b", title: "B shared", slug: "b-shared", category: "General", bodyHtml: "<p>s</p>", status: "published", shared: true, sortOrder: 1, createdAt: now(), updatedAt: now() },
  ]);
  await db.insert(helpImages).values([
    { id: "img-a", orgId: "org-a", articleId: "a-pub", r2Key: "help/org-a/1.png", contentType: "image/png", createdAt: now() },
    { id: "img-b-priv", orgId: "org-b", articleId: "b-pub", r2Key: "help/org-b/1.png", contentType: "image/png", createdAt: now() },
    { id: "img-b-shared", orgId: "org-b", articleId: "b-shared", r2Key: "help/org-b/2.png", contentType: "image/png", createdAt: now() },
  ]);
}

beforeEach(seed);

describe("help CMS cross-org reads (spec 0024)", () => {
  it("AC-4: a reader sees own published + shared published, never drafts or others' non-shared", async () => {
    const forA = (await orgDb("org-a", db).help.listForReader()).map((a) => a.id).sort();
    expect(forA).toEqual(["a-pub", "b-shared"]); // own published + the shared one
    expect(forA).not.toContain("a-draft"); // own draft hidden
    expect(forA).not.toContain("b-pub"); // other org's non-shared hidden

    const forB = (await orgDb("org-b", db).help.listForReader()).map((a) => a.id).sort();
    expect(forB).toEqual(["b-pub", "b-shared"]);
  });

  it("AC-4: getForReader returns own or shared, but not another org's non-shared or a draft", async () => {
    expect((await orgDb("org-a", db).help.getForReader("a-pub"))?.id).toBe("a-pub");
    expect((await orgDb("org-a", db).help.getForReader("b-shared"))?.id).toBe("b-shared");
    expect(await orgDb("org-a", db).help.getForReader("b-pub")).toBeUndefined();
    expect(await orgDb("org-a", db).help.getForReader("a-draft")).toBeUndefined();
  });

  it("AC-7: an image is servable for its own org, or if referenced by a published+shared article", async () => {
    // Own-org image: servable for A, not for B.
    expect((await orgDb("org-a", db).help.getServableImage("img-a"))?.id).toBe("img-a");
    expect(await orgDb("org-b", db).help.getServableImage("img-a")).toBeUndefined();

    // B's shared-article image: servable cross-org (for A).
    expect((await orgDb("org-a", db).help.getServableImage("img-b-shared"))?.id).toBe("img-b-shared");

    // B's non-shared image: NOT servable for A.
    expect(await orgDb("org-a", db).help.getServableImage("img-b-priv")).toBeUndefined();
    // ...but servable for its own org B.
    expect((await orgDb("org-b", db).help.getServableImage("img-b-priv"))?.id).toBe("img-b-priv");
  });
});
