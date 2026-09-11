import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { buildDb } from "../src/server/db";
import {
  cardStatDaily,
  cardVisitEvent,
  files,
  organization,
  user,
} from "../src/server/db/schema";
import { uuidv7 } from "../src/server/id";
import { orgDbFor } from "../src/server/org-db";
import type { UploadEnv } from "../src/server/uploads";
import {
  describeUserAgent,
  formatVisitorDevice,
  purgeExpiredVisitEvents,
  recordCardVisit,
  type VisitEnv,
} from "../src/server/visits";

const db = buildDb(env.DB);
const ENV = { DB: env.DB, IP_HASH_SALT: "test-salt" } as unknown as VisitEnv &
  UploadEnv;

async function insertCard(id: string, orgId = "org-a", name = id) {
  const now = new Date();
  await db.insert(files).values({
    id,
    orgId,
    uploadedBy: "user-x",
    originalName: `${id}.vcf`,
    contentType: "text/vcard",
    sizeBytes: 100,
    checksumSha256: `${id}-sum`,
    storageKey: `files/${id}`,
    bucket: "public",
    visibility: "public",
    kind: "vcard",
    status: "ready",
    publicSlug: id,
    contactName: name,
    publishedAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

/** A base capture payload; override per test. */
function hit(over: Partial<Parameters<typeof recordCardVisit>[1]> = {}) {
  return {
    fileId: "f1",
    orgId: "org-a",
    metric: "view" as const,
    ip: "203.0.113.7",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
    referrer: "https://example.com/page",
    src: null,
    cf: undefined,
    countryHeader: "US",
    ...over,
  };
}

beforeEach(async () => {
  await db.delete(cardVisitEvent);
  await db.delete(cardStatDaily);
  await db.delete(files);
  await db.delete(organization);
  await db.delete(user);
  await db.insert(user).values({
    id: "user-x",
    name: "X",
    email: "x@e.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(organization).values([
    { id: "org-a", name: "A", slug: "org-a", createdAt: new Date() },
    { id: "org-b", name: "B", slug: "org-b", createdAt: new Date() },
  ]);
});

describe("describeUserAgent / formatVisitorDevice (AC-1)", () => {
  it("derives browser, OS, and device type from common user agents", () => {
    expect(
      describeUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
      ),
    ).toEqual({ browser: "Safari", os: "iOS", deviceType: "Mobile" });

    expect(
      describeUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
      ),
    ).toEqual({ browser: "Chrome", os: "Windows", deviceType: "Desktop" });

    expect(
      describeUserAgent(
        "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36",
      ),
    ).toEqual({ browser: "Chrome", os: "Android", deviceType: "Mobile" });

    expect(
      describeUserAgent(
        "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0",
      ).browser,
    ).toBe("Edge");
  });

  it("is null-safe and labels an unknown UA", () => {
    expect(describeUserAgent(null)).toEqual({
      browser: "Unknown",
      os: "Unknown",
      deviceType: "Unknown",
    });
    expect(formatVisitorDevice(null)).toBe("Unknown device");
    expect(
      formatVisitorDevice(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36",
      ),
    ).toBe("Chrome on Windows · Desktop");
  });
});

describe("recordCardVisit (AC-1, AC-3)", () => {
  it("writes one row with the metric, IP, referrer, src, and derived fields", async () => {
    await insertCard("f1");
    await recordCardVisit(ENV, hit({ src: "qr", metric: "scan" }));
    const rows = await db.select().from(cardVisitEvent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId: "org-a",
      fileId: "f1",
      metric: "scan",
      ip: "203.0.113.7",
      referrer: "https://example.com/page",
      src: "qr",
      country: "US", // from the CF-IPCountry header fallback (cf absent)
    });
    expect(rows[0].visitorHash).toBeTruthy();
    // Geo/network are null when cf is unavailable (degrades to IP + country).
    expect(rows[0].city).toBeNull();
    expect(rows[0].asn).toBeNull();
  });

  it("maps the Cloudflare cf geo/network fields when present", async () => {
    await insertCard("f1");
    await recordCardVisit(
      ENV,
      hit({
        cf: {
          country: "GB",
          region: "England",
          city: "London",
          postalCode: "EC1",
          latitude: "51.5",
          longitude: "-0.1",
          timezone: "Europe/London",
          asn: 12345,
          asOrganization: "Example ISP",
        },
        countryHeader: "US", // cf.country wins over the header
      }),
    );
    const [row] = await db.select().from(cardVisitEvent);
    expect(row).toMatchObject({
      country: "GB",
      region: "England",
      city: "London",
      postal: "EC1",
      latitude: 51.5,
      longitude: -0.1,
      timezone: "Europe/London",
      asn: 12345,
      asOrg: "Example ISP",
    });
  });

  it("never throws, even when the write cannot happen (AC-3)", async () => {
    // An empty orgId makes the scoped insert throw internally; recordCardVisit
    // must swallow it so the public response path is never affected.
    await expect(
      recordCardVisit(ENV, hit({ orgId: "" })),
    ).resolves.toBeUndefined();
    expect(await db.select().from(cardVisitEvent)).toHaveLength(0);
  });
});

describe("uniqueCount (AC-5)", () => {
  it("counts one visitor for repeat hits from the same IP + UA + day, two for a different IP", async () => {
    await insertCard("f1");
    const ua = hit().userAgent;
    await recordCardVisit(ENV, hit({ ip: "203.0.113.7", userAgent: ua }));
    await recordCardVisit(ENV, hit({ ip: "203.0.113.7", userAgent: ua }));
    let unique = await orgDbFor("org-a", env.DB).visits.uniqueCount({});
    expect(unique).toBe(1);
    await recordCardVisit(ENV, hit({ ip: "198.51.100.9", userAgent: ua }));
    unique = await orgDbFor("org-a", env.DB).visits.uniqueCount({});
    expect(unique).toBe(2);
  });
});

describe("listPage feed (AC-6, AC-8)", () => {
  it("returns events newest first, filterable by card and metric", async () => {
    await insertCard("f1", "org-a", "Jane Doe");
    await insertCard("f2", "org-a", "John Roe");
    await recordCardVisit(ENV, hit({ fileId: "f1", metric: "view" }));
    await recordCardVisit(ENV, hit({ fileId: "f2", metric: "download" }));
    await recordCardVisit(ENV, hit({ fileId: "f1", metric: "scan" }));

    const all = await orgDbFor("org-a", env.DB).visits.listPage({});
    expect(all.items).toHaveLength(3);
    // Newest first: uuidv7 ids sort by creation, so the last-inserted leads.
    expect(all.items[0].metric).toBe("scan");

    const byCard = await orgDbFor("org-a", env.DB).visits.listPage({
      fileId: "f1",
    });
    expect(byCard.items.map((i) => i.fileId)).toEqual(["f1", "f1"]);
    expect(byCard.items[0].cardName).toBe("Jane Doe");

    const byMetric = await orgDbFor("org-a", env.DB).visits.listPage({
      metric: "download",
    });
    expect(byMetric.items.map((i) => i.metric)).toEqual(["download"]);
  });

  it("keyset-paginates with a stable cursor", async () => {
    await insertCard("f1");
    for (let i = 0; i < 3; i++) await recordCardVisit(ENV, hit());
    const page1 = await orgDbFor("org-a", env.DB).visits.listPage({ limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await orgDbFor("org-a", env.DB).visits.listPage({
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.items).toHaveLength(1);
    // No overlap between the pages.
    const ids = new Set(page1.items.map((i) => i.id));
    expect(page2.items.some((i) => ids.has(i.id))).toBe(false);
  });

  it("never returns another org's events (AC-8)", async () => {
    await insertCard("f1", "org-a");
    await insertCard("f2", "org-b");
    await recordCardVisit(ENV, hit({ fileId: "f1", orgId: "org-a" }));
    await recordCardVisit(ENV, hit({ fileId: "f2", orgId: "org-b" }));
    const aFeed = await orgDbFor("org-a", env.DB).visits.listPage({});
    expect(aFeed.items.map((i) => i.fileId)).toEqual(["f1"]);
    const bUnique = await orgDbFor("org-b", env.DB).visits.uniqueCount({});
    expect(bUnique).toBe(1);
  });
});

describe("filterCards dropdown source (AC-6, AC-8)", () => {
  it("lists only cards with visits, name-sorted, and stays org-scoped", async () => {
    await insertCard("f1", "org-a", "Bravo");
    await insertCard("f2", "org-a", "Alpha");
    await insertCard("f3", "org-a", "Charlie"); // no visits → excluded
    await insertCard("f4", "org-b", "Delta");
    await recordCardVisit(ENV, hit({ fileId: "f1", orgId: "org-a" }));
    await recordCardVisit(ENV, hit({ fileId: "f2", orgId: "org-a" }));
    await recordCardVisit(ENV, hit({ fileId: "f4", orgId: "org-b" }));

    const cards = await orgDbFor("org-a", env.DB).visits.filterCards();
    // Sorted by name; the visit-less card and org-b's card are absent.
    expect(cards.map((c) => c.name)).toEqual(["Alpha", "Bravo"]);
    expect(cards.map((c) => c.fileId)).toEqual(["f2", "f1"]);
    expect(cards.some((c) => c.fileId === "f3")).toBe(false);
    expect(cards.some((c) => c.fileId === "f4")).toBe(false);
  });
});

describe("retention purge (AC-9)", () => {
  it("removes events past 12 months, keeps recent ones, and leaves the rollup untouched", async () => {
    await insertCard("f1");
    const now = new Date();
    const old = new Date(Date.now() - 400 * 86_400_000); // > 12 months
    await db.insert(cardVisitEvent).values([
      { id: uuidv7(), orgId: "org-a", fileId: "f1", metric: "view", createdAt: old },
      { id: uuidv7(), orgId: "org-a", fileId: "f1", metric: "view", createdAt: now },
    ]);
    // A rollup row that must survive the purge.
    await db
      .insert(cardStatDaily)
      .values({ orgId: "org-a", fileId: "f1", date: "2020-01-01", metric: "view", count: 5 });

    const result = await purgeExpiredVisitEvents(ENV);
    expect(result.deleted).toBe(1);
    const remaining = await db.select().from(cardVisitEvent);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].createdAt.getTime()).toBe(now.getTime());
    // The daily rollup is never purged here.
    expect(await db.select().from(cardStatDaily)).toHaveLength(1);
  });
});
