import { describe, expect, it } from "vitest";
import {
  AW_SIGNATURE_BRAND,
  logoForState,
  normalizeState,
  socialsForState,
} from "../src/lib/signature-brand";

describe("normalizeState", () => {
  it("passes through 2-letter abbreviations (any case)", () => {
    expect(normalizeState("NY")).toBe("NY");
    expect(normalizeState("ny")).toBe("NY");
    expect(normalizeState(" ca ")).toBe("CA");
  });
  it("maps full state names", () => {
    expect(normalizeState("New York")).toBe("NY");
    expect(normalizeState("new york")).toBe("NY");
    expect(normalizeState("California")).toBe("CA");
  });
  it("returns '' for unknown/empty", () => {
    expect(normalizeState("")).toBe("");
    expect(normalizeState("Atlantis")).toBe("");
  });
});

describe("socialsForState", () => {
  it("returns the NY overrides for New York cards", () => {
    for (const state of ["NY", "ny", "New York"]) {
      const s = socialsForState(AW_SIGNATURE_BRAND, state);
      expect(s.facebook).toBe("https://www.facebook.com/AWNewYork");
      expect(s.x).toBe("https://twitter.com/americaworksnys?lang=en");
      expect(s.instagram).toBe("https://www.instagram.com/americaworksny");
    }
  });
  it("falls back to the org-wide socials for other/unknown states", () => {
    expect(socialsForState(AW_SIGNATURE_BRAND, "CA")).toBe(
      AW_SIGNATURE_BRAND.socials,
    );
    expect(socialsForState(AW_SIGNATURE_BRAND, "")).toBe(
      AW_SIGNATURE_BRAND.socials,
    );
  });
});

describe("logoForState", () => {
  it("returns the state-specific logo (name or abbreviation)", () => {
    expect(logoForState(AW_SIGNATURE_BRAND, "California")).toBe("/logos/ca.png");
    expect(logoForState(AW_SIGNATURE_BRAND, "md")).toBe("/logos/md.png");
    expect(logoForState(AW_SIGNATURE_BRAND, "DC")).toBe("/logos/dc.png");
    expect(logoForState(AW_SIGNATURE_BRAND, "New York")).toBe("/aw-logo.png");
  });
  it("falls back to the default logo for unmapped/empty states", () => {
    expect(logoForState(AW_SIGNATURE_BRAND, "TX")).toBe(
      AW_SIGNATURE_BRAND.logoPath,
    );
    expect(logoForState(AW_SIGNATURE_BRAND, "")).toBe(
      AW_SIGNATURE_BRAND.logoPath,
    );
  });
});
