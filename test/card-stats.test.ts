import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  cardStatDetail,
  cardTotalsForFiles,
  cardTotalsOrZero,
  isCountableUserAgent,
  orgEngagement,
  recordCardHit,
} from "../src/server/card-stats";
import { buildDb } from "../src/server/db";
import { cardStatDaily, files, organization, user } from "../src/server/db/schema";
import { resolveCardBySlug } from "../src/server/signature";
import type { UploadEnv } from "../src/server/uploads";

const db = buildDb(env.DB);
const ENV = { DB: env.DB } as unknown as UploadEnv;

async function insertCard(over: {
  id: string;
  orgId?: string;
  uploadedBy?: string;
  slug?: string | null;
  visibility?: "private" | "public";
  kind?: "vcard" | "other";
  deleted?: boolean;
}) {
  const now = new Date();
  await db.insert(files).values({
    id: over.id,
    orgId: over.orgId ?? "org-a",
    uploadedBy: over.uploadedBy ?? "user-x",
    originalName: `${over.id}.vcf`,
    contentType: "text/vcard",
    sizeBytes: 100,
    checksumSha256: `${over.id}-sum`,
    storageKey: `files/${over.id}`,
    bucket: over.visibility === "public" ? "public" : "private",
    visibility: over.visibility ?? "public",
    kind: over.kind ?? "vcard",
    status: "ready",
    publicSlug: over.slug === undefined ? over.id : over.slug,
    publishedAt: over.visibility === "private" ? null : now,
    createdAt: now,
    updatedAt: now,
    deletedAt: over.deleted ? now : null,
  });
}

beforeEach(async () => {
  await db.delete(cardStatDaily);
  await db.delete(files);
  await db.delete(organization);
  await db.delete(user);
  await db.insert(user).values([
    { id: "user-x", name: "X", email: "x@e.com", emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: "user-y", name: "Y", email: "y@e.com", emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ]);
  await db.insert(organization).values([
    { id: "org-a", name: "A", slug: "org-a", createdAt: new Date() },
    { id: "org-b", name: "B", slug: "org-b", createdAt: new Date() },
  ]);
});

describe("isCountableUserAgent", () => {
  it("does not count known bots and link-preview fetchers (AC-4)", () => {
    for (const ua of [
      "Mozilla/5.0 (compatible; Googlebot/2.1)",
      "facebookexternalhit/1.1",
      "Slackbot-LinkExpanding 1.0",
      "WhatsApp/2.23",
      "Twitterbot/1.0",
      "LinkedInBot/1.0",
      "curl/8.4.0",
    ]) {
      expect(isCountableUserAgent(ua)).toBe(false);
    }
  });

  it("counts real browsers and an empty user agent", () => {
    expect(
      isCountableUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Version/17.0 Mobile/15E Safari/604.1",
      ),
    ).toBe(true);
    expect(isCountableUserAgent(null)).toBe(true);
    expect(isCountableUserAgent("")).toBe(true);
  });
});

describe("recordCardHit", () => {
  it("increments a per-card/day/metric counter with an atomic UPSERT (AC-3)", async () => {
    await insertCard({ id: "f1" });
    // Ten concurrent view hits on the same card/day must sum to exactly 10.
    await Promise.all(
      Array.from({ length: 10 }, () =>
        recordCardHit(ENV, { fileId: "f1", orgId: "org-a", metric: "view" }),
      ),
    );
    const totals = cardTotalsOrZero(await cardTotalsForFiles(ENV, "org-a", ["f1"]), "f1");
    expect(totals.views).toBe(10);
  });

  it("keeps the four metrics separate", async () => {
    await insertCard({ id: "f1" });
    await recordCardHit(ENV, { fileId: "f1", orgId: "org-a", metric: "view" });
    await recordCardHit(ENV, { fileId: "f1", orgId: "org-a", metric: "scan" });
    await recordCardHit(ENV, { fileId: "f1", orgId: "org-a", metric: "scan" });
    await recordCardHit(ENV, { fileId: "f1", orgId: "org-a", metric: "download" });
    await recordCardHit(ENV, { fileId: "f1", orgId: "org-a", metric: "pdf" });
    await recordCardHit(ENV, { fileId: "f1", orgId: "org-a", metric: "pdf" });
    await recordCardHit(ENV, { fileId: "f1", orgId: "org-a", metric: "pdf" });
    const t = cardTotalsOrZero(await cardTotalsForFiles(ENV, "org-a", ["f1"]), "f1");
    expect(t).toMatchObject({ views: 1, scans: 2, downloads: 1, pdfs: 3 });
  });

  it("counts a PDF save without touching the .vcf download total", async () => {
    await insertCard({ id: "f1" });
    await recordCardHit(ENV, { fileId: "f1", orgId: "org-a", metric: "pdf" });
    const t = cardTotalsOrZero(await cardTotalsForFiles(ENV, "org-a", ["f1"]), "f1");
    expect(t.pdfs).toBe(1);
    expect(t.downloads).toBe(0);
    expect(t.views).toBe(0);
  });

  it("returns all-zero totals for a card with no activity", async () => {
    await insertCard({ id: "f1" });
    const t = cardTotalsOrZero(await cardTotalsForFiles(ENV, "org-a", ["f1"]), "f1");
    expect(t).toEqual({
      views: 0,
      scans: 0,
      downloads: 0,
      pdfs: 0,
      lastActivity: null,
    });
  });
});

describe("cardTotalsForFiles org scope", () => {
  it("never counts another org's rows for the same file id set", async () => {
    await insertCard({ id: "f1", orgId: "org-a" });
    await recordCardHit(ENV, { fileId: "f1", orgId: "org-a", metric: "view" });
    // Asking as org-b must see nothing for f1.
    const totals = await cardTotalsForFiles(ENV, "org-b", ["f1"]);
    expect(totals.size).toBe(0);
  });
});

describe("resolveCardBySlug", () => {
  it("resolves a live published vCard to its file + org (AC-2/AC-6)", async () => {
    await insertCard({ id: "f1", slug: "Jane_Doe", orgId: "org-a" });
    const ref = await resolveCardBySlug(ENV, "Jane_Doe");
    expect(ref).toEqual({ fileId: "f1", orgId: "org-a", slug: "Jane_Doe" });
  });

  it("returns null for unknown, private, or deleted slugs (AC-6)", async () => {
    await insertCard({ id: "priv", slug: "Priv", visibility: "private" });
    await insertCard({ id: "del", slug: "Del", deleted: true });
    await insertCard({ id: "other", slug: "Other", kind: "other" });
    expect(await resolveCardBySlug(ENV, "Nope")).toBeNull();
    expect(await resolveCardBySlug(ENV, "Priv")).toBeNull();
    expect(await resolveCardBySlug(ENV, "Del")).toBeNull();
    expect(await resolveCardBySlug(ENV, "Other")).toBeNull();
  });
});

describe("orgEngagement role scoping (AC-8)", () => {
  it("totals the whole org for an owner/admin, and ranks top cards", async () => {
    await insertCard({ id: "f1", uploadedBy: "user-x" });
    await insertCard({ id: "f2", uploadedBy: "user-y" });
    // f2 is more popular.
    await recordCardHit(ENV, { fileId: "f1", orgId: "org-a", metric: "view" });
    for (let i = 0; i < 3; i++) {
      await recordCardHit(ENV, { fileId: "f2", orgId: "org-a", metric: "view" });
    }
    const eng = await orgEngagement(ENV, "org-a");
    expect(eng.totals.views).toBe(4);
    expect(eng.topCards[0].fileId).toBe("f2");
  });

  it("restricts a member to only their own cards' numbers", async () => {
    await insertCard({ id: "f1", uploadedBy: "user-x" });
    await insertCard({ id: "f2", uploadedBy: "user-y" });
    await recordCardHit(ENV, { fileId: "f1", orgId: "org-a", metric: "view" });
    await recordCardHit(ENV, { fileId: "f2", orgId: "org-a", metric: "view" });
    const mine = await orgEngagement(ENV, "org-a", { uploaderUserId: "user-x" });
    expect(mine.totals.views).toBe(1);
    expect(mine.topCards.map((c) => c.fileId)).toEqual(["f1"]);
  });
});

describe("cardStatDetail", () => {
  it("returns all-time totals plus a daily series (AC-7)", async () => {
    await insertCard({ id: "f1" });
    await recordCardHit(ENV, { fileId: "f1", orgId: "org-a", metric: "download" });
    await recordCardHit(ENV, { fileId: "f1", orgId: "org-a", metric: "download" });
    await recordCardHit(ENV, { fileId: "f1", orgId: "org-a", metric: "pdf" });
    const detail = await cardStatDetail(ENV, "org-a", "f1", 30);
    expect(detail.totals.downloads).toBe(2);
    expect(detail.totals.pdfs).toBe(1);
    expect(detail.series.length).toBe(1);
    expect(detail.series[0].downloads).toBe(2);
    expect(detail.series[0].pdfs).toBe(1);
  });
});

describe("orgEngagement pdf metric", () => {
  it("rolls PDF saves into their own total, series point, and top-card column", async () => {
    await insertCard({ id: "f1" });
    await recordCardHit(ENV, { fileId: "f1", orgId: "org-a", metric: "pdf" });
    await recordCardHit(ENV, { fileId: "f1", orgId: "org-a", metric: "pdf" });
    await recordCardHit(ENV, { fileId: "f1", orgId: "org-a", metric: "view" });

    const eng = await orgEngagement(ENV, "org-a");
    expect(eng.totals.pdfs).toBe(2);
    expect(eng.totals.downloads).toBe(0);
    expect(eng.series[0].pdfs).toBe(2);
    expect(eng.topCards[0]).toMatchObject({ fileId: "f1", pdfs: 2, views: 1 });
  });
});
