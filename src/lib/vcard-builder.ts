// Build a vCard 3.0 from form fields — a TypeScript port of the engineer's
// Python generator (docs/Designs/vcf Generator.py), minus Excel/photo, plus
// RFC 6350 escaping. Output passes src/server/vcard.ts `validateVcard`
// (VERSION:3.0, single-line fields, FN present) and flows through the normal
// upload → publish pipeline.

import type { ParsedVcard } from "@/server/vcard";

export interface CardFields {
  firstName: string;
  lastName: string;
  fullName?: string;
  email: string;
  mobilePhone?: string;
  workPhone?: string;
  fax?: string;
  organization?: string;
  jobTitle?: string;
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  website?: string;
}

/**
 * Normalise a phone number, matching the Python `parse_phone_number`:
 * strip non-digits; 10 digits → `1##########`; 11 digits starting `1` → as-is;
 * anything else → null. An `x`/`ext`/`extension` suffix becomes `,,<ext>`.
 */
export function parsePhone(input: string): string | null {
  if (!input || typeof input !== "string") return null;
  let s = input.trim();

  let extension = "";
  const extMatch = s.match(/(?:x|ext|extension)[:\s]*([0-9]+)/i);
  if (extMatch && extMatch.index !== undefined) {
    extension = extMatch[1];
    s = s.slice(0, extMatch.index).trim();
  }

  const digits = s.replace(/\D/g, "");
  let formatted: string;
  if (digits.length === 10) formatted = `1${digits}`;
  else if (digits.length === 11 && digits[0] === "1") formatted = digits;
  else return null; // 7-digit and everything else

  if (extension) formatted = `${formatted},,${extension}`;
  return formatted;
}

/** Escape a text value per RFC 6350 (backslash, newline, comma, semicolon). */
export function escapeVcard(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/** Assemble a vCard 3.0 string (CRLF), emitting only non-empty fields. */
export function buildVcard(f: CardFields): string {
  const e = escapeVcard;
  const first = f.firstName.trim();
  const last = f.lastName.trim();
  const full = (f.fullName?.trim() || `${first} ${last}`).trim();

  const lines: string[] = ["BEGIN:VCARD", "VERSION:3.0"];
  // N: Family;Given;Additional;Prefix;Suffix
  lines.push(`N:${e(last)};${e(first)};;;`);
  lines.push(`FN:${e(full)}`);
  lines.push(`EMAIL;TYPE=WORK:${e(f.email.trim())}`);

  const mobile = f.mobilePhone?.trim() ? parsePhone(f.mobilePhone) : null;
  if (mobile) lines.push(`TEL;TYPE=CELL,VOICE:${mobile}`);

  if (f.organization?.trim()) lines.push(`ORG:${e(f.organization.trim())}`);
  if (f.jobTitle?.trim()) lines.push(`TITLE:${e(f.jobTitle.trim())}`);

  const adr = [f.street, f.city, f.state, f.zip, f.country].map((v) =>
    (v ?? "").trim(),
  );
  // Emit an address only when there's a real component (street/city/state/zip);
  // a default country like "USA" on its own is not an address.
  if (adr.slice(0, 4).some((v) => v !== "")) {
    // ADR: POBox;Ext;Street;City;State;Zip;Country
    lines.push(`ADR;TYPE=WORK:;;${adr.map(e).join(";")}`);
  }

  if (f.website?.trim()) lines.push(`URL;TYPE=WORK:${e(f.website.trim())}`);

  if (f.workPhone?.trim()) {
    const parsed = parsePhone(f.workPhone);
    // Matches the Python: keep a non-empty work phone verbatim if it won't parse.
    lines.push(`TEL;TYPE=WORK,VOICE:${parsed ?? e(f.workPhone.trim())}`);
  }
  if (f.fax?.trim()) lines.push(`TEL;TYPE=WORK,FAX:${e(f.fax.trim())}`);

  lines.push("END:VCARD");
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * Map a parsed stored vCard back into editable form fields (spec 0006 follow-up:
 * Edit Card). The inverse of `buildVcard` for the round-trip: parseVcard →
 * cardFieldsFromParsed → edit → buildVcard. Phone numbers come back display-
 * formatted; `parsePhone` re-normalises them on the way out.
 */
export function cardFieldsFromParsed(card: ParsedVcard): CardFields {
  return {
    firstName: card.firstName,
    lastName: card.lastName,
    fullName: card.fullName,
    email: card.email,
    mobilePhone: card.mobilePhone,
    workPhone: card.workPhone,
    fax: card.fax,
    organization: card.organization,
    jobTitle: card.title,
    street: card.address.street,
    city: card.address.city,
    state: card.address.state,
    zip: card.address.zip,
    country: card.address.country,
    website: card.website,
  };
}

/** A safe `.vcf` filename from the contact's name. */
export function cardFileName(f: CardFields): string {
  const base = `${f.firstName}_${f.lastName}`
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${base || "contact"}.vcf`;
}
