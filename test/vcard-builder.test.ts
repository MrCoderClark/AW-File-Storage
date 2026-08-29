import { describe, expect, it } from "vitest";
import { deriveSlug, validateVcard } from "../src/server/vcard";
import {
  buildVcard,
  type CardFields,
  cardFileName,
  escapeVcard,
  parsePhone,
} from "../src/lib/vcard-builder";

describe("parsePhone (port of the Python parser)", () => {
  it("formats 10 digits as 1 + digits", () => {
    expect(parsePhone("(555) 123-4567")).toBe("15551234567");
    expect(parsePhone("555.123.4567")).toBe("15551234567");
  });
  it("keeps 11 digits starting with 1", () => {
    expect(parsePhone("1-555-123-4567")).toBe("15551234567");
  });
  it("rejects 7-digit and malformed numbers", () => {
    expect(parsePhone("123-4567")).toBeNull();
    expect(parsePhone("abc")).toBeNull();
    expect(parsePhone("")).toBeNull();
  });
  it("appends an extension as ,,ext", () => {
    expect(parsePhone("555 123 4567 x89")).toBe("15551234567,,89");
    expect(parsePhone("(555) 123-4567 ext: 12")).toBe("15551234567,,12");
  });
});

describe("escapeVcard (RFC 6350)", () => {
  it("escapes backslash, comma, semicolon, and newline", () => {
    expect(escapeVcard("Smith, Jr.")).toBe("Smith\\, Jr.");
    expect(escapeVcard("a;b")).toBe("a\\;b");
    expect(escapeVcard("a\\b")).toBe("a\\\\b");
    expect(escapeVcard("line1\nline2")).toBe("line1\\nline2");
  });
});

const minimal: CardFields = {
  firstName: "Jane",
  lastName: "Doe",
  email: "jane@example.com",
};

describe("buildVcard", () => {
  it("builds a minimal card that validates", () => {
    const vcf = buildVcard(minimal);
    expect(vcf).toContain("BEGIN:VCARD");
    expect(vcf).toContain("VERSION:3.0");
    expect(vcf).toContain("N:Doe;Jane;;;");
    expect(vcf).toContain("FN:Jane Doe");
    expect(vcf).toContain("EMAIL;TYPE=WORK:jane@example.com");
    expect(vcf.trimEnd().endsWith("END:VCARD")).toBe(true);

    const result = validateVcard(vcf);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.formattedName).toBe("Jane Doe");
  });

  it("defaults full name to First Last, but respects an explicit one", () => {
    expect(buildVcard(minimal)).toContain("FN:Jane Doe");
    expect(buildVcard({ ...minimal, fullName: "Dr. Jane Doe" })).toContain(
      "FN:Dr. Jane Doe",
    );
  });

  it("emits only non-empty fields, in the Python order", () => {
    const full: CardFields = {
      ...minimal,
      mobilePhone: "(555) 111-2222",
      organization: "Acme",
      jobTitle: "Engineer",
      street: "1 Main St",
      city: "Town",
      state: "TX",
      zip: "75001",
      country: "USA",
      website: "https://acme.example",
      workPhone: "555-333-4444",
      fax: "555-555-6666",
    };
    const vcf = buildVcard(full);
    expect(vcf).toContain("TEL;TYPE=CELL,VOICE:15551112222");
    expect(vcf).toContain("ORG:Acme");
    expect(vcf).toContain("TITLE:Engineer");
    expect(vcf).toContain("ADR;TYPE=WORK:;;1 Main St;Town;TX;75001;USA");
    expect(vcf).toContain("URL;TYPE=WORK:https://acme.example");
    expect(vcf).toContain("TEL;TYPE=WORK,VOICE:15553334444");
    expect(vcf).toContain("TEL;TYPE=WORK,FAX:");
    expect(validateVcard(vcf).ok).toBe(true);
  });

  it("does not emit an address for a lone country (e.g. the USA default)", () => {
    const vcf = buildVcard({ ...minimal, country: "USA" });
    expect(vcf).not.toContain("ADR");
    // but a real component brings the country along
    expect(buildVcard({ ...minimal, city: "Austin", country: "USA" })).toContain(
      "ADR;TYPE=WORK:;;;Austin;;;USA",
    );
  });

  it("escapes special characters so structure can't break", () => {
    const vcf = buildVcard({ ...minimal, lastName: "Smith, Jr.", organization: "A;B" });
    expect(vcf).toContain("N:Smith\\, Jr.;Jane;;;");
    expect(vcf).toContain("ORG:A\\;B");
    expect(validateVcard(vcf).ok).toBe(true);
  });
});

describe("deriveSlug (First_Last, case preserved)", () => {
  it("joins words with underscores and keeps case", () => {
    expect(deriveSlug("Jay Clark")).toBe("Jay_Clark");
    expect(deriveSlug("Mary Jane Watson")).toBe("Mary_Jane_Watson");
  });
  it("strips accents and punctuation", () => {
    expect(deriveSlug("José O'Brien")).toBe("Jose_O_Brien");
  });
  it("falls back to 'contact' when empty", () => {
    expect(deriveSlug("!!!")).toBe("contact");
  });
});

describe("cardFileName", () => {
  it("builds a safe .vcf filename", () => {
    expect(cardFileName(minimal)).toBe("Jane_Doe.vcf");
    expect(cardFileName({ ...minimal, firstName: "Jo/e", lastName: "O'Neil" })).toBe(
      "Jo_e_O_Neil.vcf",
    );
  });
});
