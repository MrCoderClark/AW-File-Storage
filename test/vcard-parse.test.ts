import { describe, expect, it } from "vitest";
import { buildVcard, type CardFields } from "../src/lib/vcard-builder";
import { formatPhoneDisplay, parseVcard } from "../src/server/vcard";

describe("formatPhoneDisplay", () => {
  it("formats a stored 11-digit NANP number", () => {
    expect(formatPhoneDisplay("15551234567")).toBe("(555) 123-4567");
  });
  it("formats a bare 10-digit number", () => {
    expect(formatPhoneDisplay("5551234567")).toBe("(555) 123-4567");
  });
  it("renders an extension", () => {
    expect(formatPhoneDisplay("15551234567,,89")).toBe("(555) 123-4567 x89");
  });
  it("passes non-NANP values through", () => {
    expect(formatPhoneDisplay("+44 20 7946 0000")).toBe("+44 20 7946 0000");
    expect(formatPhoneDisplay("")).toBe("");
  });
  it("returns '' for values with no digits (empty Excel cell → 'nan')", () => {
    expect(formatPhoneDisplay("nan")).toBe("");
    expect(formatPhoneDisplay("N/A")).toBe("");
    expect(formatPhoneDisplay("  ")).toBe("");
  });
});

describe("parseVcard", () => {
  const fields: CardFields = {
    firstName: "Jay",
    lastName: "Clark",
    email: "jay@americaworks.com",
    mobilePhone: "(212) 555-0100",
    workPhone: "212-555-0111",
    fax: "212-555-0122",
    organization: "America Works",
    jobTitle: "Program Director",
    street: "123 Main St",
    city: "New York",
    state: "NY",
    zip: "10001",
    country: "USA",
    website: "https://americaworks.com",
  };

  it("round-trips fields built by buildVcard", () => {
    const parsed = parseVcard(buildVcard(fields));
    expect(parsed.fullName).toBe("Jay Clark");
    expect(parsed.firstName).toBe("Jay");
    expect(parsed.lastName).toBe("Clark");
    expect(parsed.organization).toBe("America Works");
    expect(parsed.title).toBe("Program Director");
    expect(parsed.email).toBe("jay@americaworks.com");
    expect(parsed.website).toBe("https://americaworks.com");
  });

  it("classifies phone numbers by TYPE", () => {
    const parsed = parseVcard(buildVcard(fields));
    expect(parsed.mobilePhone).toBe("(212) 555-0100");
    expect(parsed.workPhone).toBe("(212) 555-0111");
    expect(parsed.fax).toBe("(212) 555-0122");
  });

  it("builds a one-line formatted address", () => {
    const parsed = parseVcard(buildVcard(fields));
    expect(parsed.address.street).toBe("123 Main St");
    expect(parsed.address.city).toBe("New York");
    expect(parsed.address.state).toBe("NY");
    expect(parsed.address.zip).toBe("10001");
    expect(parsed.address.formatted).toBe(
      "123 Main St, New York, NY 10001, USA",
    );
  });

  it("unescapes RFC 6350 sequences", () => {
    const raw = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "N:O'Brien\\, Inc.;Sean;;;",
      "FN:Sean O'Brien\\, Jr.",
      "ORG:Acme\\; Co.",
      "END:VCARD",
    ].join("\r\n");
    const parsed = parseVcard(raw);
    expect(parsed.fullName).toBe("Sean O'Brien, Jr.");
    expect(parsed.lastName).toBe("O'Brien, Inc.");
    expect(parsed.organization).toBe("Acme; Co.");
  });

  it("unfolds continuation lines", () => {
    const raw = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Alexandra",
      "TITLE:Senior Regional Prog",
      " ram Coordinator",
      "END:VCARD",
    ].join("\r\n");
    const parsed = parseVcard(raw);
    expect(parsed.title).toBe("Senior Regional Program Coordinator");
  });

  it("derives a name from FN when N is absent", () => {
    const raw = ["BEGIN:VCARD", "VERSION:3.0", "FN:Dana Lee", "END:VCARD"].join(
      "\r\n",
    );
    const parsed = parseVcard(raw);
    expect(parsed.firstName).toBe("Dana");
    expect(parsed.lastName).toBe("Lee");
  });

  it("returns empty strings for a minimal card", () => {
    const raw = ["BEGIN:VCARD", "VERSION:3.0", "FN:Solo", "END:VCARD"].join(
      "\r\n",
    );
    const parsed = parseVcard(raw);
    expect(parsed.email).toBe("");
    expect(parsed.mobilePhone).toBe("");
    expect(parsed.workPhone).toBe("");
    expect(parsed.fax).toBe("");
    expect(parsed.address.formatted).toBe("");
  });

  it("drops a phone with no real digits (e.g. a 'nan' fax from an empty cell)", () => {
    const raw = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Joe",
      "TEL;TYPE=CELL,VOICE:12125550100",
      "TEL;TYPE=WORK,FAX:nan",
      "END:VCARD",
    ].join("\r\n");
    const parsed = parseVcard(raw);
    expect(parsed.mobilePhone).toBe("(212) 555-0100");
    expect(parsed.fax).toBe("");
  });

  it("handles vCard 2.1 bare type params", () => {
    const raw = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Pat Doe",
      "TEL;CELL;VOICE:12125550100",
      "TEL;WORK;FAX:12125550122",
      "END:VCARD",
    ].join("\r\n");
    const parsed = parseVcard(raw);
    expect(parsed.mobilePhone).toBe("(212) 555-0100");
    expect(parsed.fax).toBe("(212) 555-0122");
  });
});
