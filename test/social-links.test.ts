import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { AW_SIGNATURE_BRAND } from "../src/lib/signature-brand";
import { buildDb } from "../src/server/db";
import { organization } from "../src/server/db/auth-schema";
import { orgSocialLinks } from "../src/server/db/schema";
import {
  deleteSocialLink,
  listSocialLinks,
  resolveSocials,
  seedDefaultsFromBrand,
  upsertSocialLink,
} from "../src/server/social-links";

const db = buildDb(env.DB);
const ENV = { DB: env.DB };
const ORG = "org-a";

async function seed() {
  await db.delete(orgSocialLinks);
  await db.delete(organization);
  await db.insert(organization).values([
    { id: ORG, name: "A", slug: "a", createdAt: new Date() },
    { id: "org-b", name: "B", slug: "b", createdAt: new Date() },
  ]);
}

beforeEach(seed);

describe("social-links service (spec 0009 follow-up)", () => {
  it("upserts a state and lists it back", async () => {
    await upsertSocialLink(ENV, ORG, {
      state: "California",
      facebook: "https://fb.com/awca",
      x: "https://x.com/awca",
      instagram: "https://instagram.com/awca",
    });
    const rows = await listSocialLinks(ENV, ORG);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("CA"); // normalized from "California"
    expect(rows[0].facebook).toBe("https://fb.com/awca");
  });

  it("upsert on the same state updates rather than duplicating", async () => {
    await upsertSocialLink(ENV, ORG, { state: "CA", facebook: "https://fb.com/one" });
    await upsertSocialLink(ENV, ORG, { state: "ca", facebook: "https://fb.com/two", x: "https://x.com/two" });
    const rows = await listSocialLinks(ENV, ORG);
    expect(rows).toHaveLength(1);
    expect(rows[0].facebook).toBe("https://fb.com/two");
    expect(rows[0].x).toBe("https://x.com/two");
  });

  it("blank URLs are stored as null", async () => {
    await upsertSocialLink(ENV, ORG, { state: "CA", facebook: "https://fb.com/x", x: "  ", instagram: "" });
    const [row] = await listSocialLinks(ENV, ORG);
    expect(row.x).toBeNull();
    expect(row.instagram).toBeNull();
  });

  it("rejects an unresolvable state", async () => {
    await expect(
      upsertSocialLink(ENV, ORG, { state: "Atlantis", facebook: "https://fb.com/x" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  describe("resolveSocials precedence", () => {
    it("uses the exact-state row when present", async () => {
      await upsertSocialLink(ENV, ORG, { state: "CA", facebook: "https://fb.com/awca" });
      const s = await resolveSocials(ENV, ORG, "California");
      expect(s.facebook).toBe("https://fb.com/awca");
      expect(s.x).toBeUndefined();
    });

    it("falls back to the org-wide '*' row when the state has none", async () => {
      await upsertSocialLink(ENV, ORG, { state: "*", facebook: "https://fb.com/awdefault" });
      const s = await resolveSocials(ENV, ORG, "TX");
      expect(s.facebook).toBe("https://fb.com/awdefault");
    });

    it("falls back to the built-in defaults when nothing is stored", async () => {
      const ny = await resolveSocials(ENV, ORG, "New York");
      expect(ny).toEqual(AW_SIGNATURE_BRAND.socialsByState.NY);
      const other = await resolveSocials(ENV, ORG, "CA");
      expect(other).toEqual(AW_SIGNATURE_BRAND.socials);
    });

    it("is org-scoped — org-b's rows don't leak into org-a", async () => {
      await upsertSocialLink(ENV, "org-b", { state: "CA", facebook: "https://fb.com/bleak" });
      const s = await resolveSocials(ENV, ORG, "CA");
      // org-a has no CA row → built-in default, not org-b's value.
      expect(s.facebook).not.toBe("https://fb.com/bleak");
    });
  });

  it("adding the org-wide '*' default keeps an existing state row (regression)", async () => {
    await upsertSocialLink(ENV, ORG, {
      state: "New York",
      facebook: "https://fb.com/awny",
      x: "https://x.com/awny",
      instagram: "https://ig.com/awny",
    });
    await upsertSocialLink(ENV, ORG, {
      state: "*",
      facebook: "https://fb.com/awdefault",
    });
    const rows = await listSocialLinks(ENV, ORG);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.state === "NY")?.facebook).toBe("https://fb.com/awny");
    expect(rows.find((r) => r.state === "*")?.facebook).toBe(
      "https://fb.com/awdefault",
    );
  });

  it("deletes a state's row", async () => {
    await upsertSocialLink(ENV, ORG, { state: "CA", facebook: "https://fb.com/x" });
    await deleteSocialLink(ENV, ORG, "California");
    expect(await listSocialLinks(ENV, ORG)).toHaveLength(0);
  });

  it("seeds the built-in defaults idempotently", async () => {
    const first = await seedDefaultsFromBrand(ENV, ORG);
    // "*" default + one per socialsByState entry (NY today).
    expect(first).toBe(1 + Object.keys(AW_SIGNATURE_BRAND.socialsByState).length);
    const rows = await listSocialLinks(ENV, ORG);
    expect(rows.some((r) => r.state === "*")).toBe(true);
    expect(rows.some((r) => r.state === "NY")).toBe(true);

    const second = await seedDefaultsFromBrand(ENV, ORG);
    expect(second).toBe(0); // nothing re-inserted
  });
});
