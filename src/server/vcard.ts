/**
 * vCard validation + normalisation (spec 0003 AC-6). A card is published only if
 * it decodes as UTF-8, is a single well-formed VCARD (3.0 or 4.0) with a
 * formatted name. The normalised text (CRLF line endings, BOM stripped) is what
 * gets published, never the raw upload. Each rejection has a readable reason.
 */
export type VcardResult =
  | { ok: true; normalized: string; formattedName: string }
  | { ok: false; reason: string };

// Abuse bounds (spec 0022). MAX_BYTES mirrors uploads.ts MAX_VCARD_BYTES and is the
// real publish gate on CONTENT size: the upload reservation only checks the client's
// declared size, so an oversized card would otherwise slip through finalize. MAX_LINES
// stops a pathological card that stays under the byte cap but has thousands of lines
// (each re-parsed on every landing/PDF hit). A normal card is a few dozen lines.
const MAX_VCARD_BYTES = 262144; // 256 KB
const MAX_VCARD_LINES = 512;

export function validateVcard(raw: string): VcardResult {
  if (new TextEncoder().encode(raw).length > MAX_VCARD_BYTES) {
    return {
      ok: false,
      reason: "The contact card is too large (256 KB maximum).",
    };
  }
  // Strip a leading byte-order mark and normalise line endings.
  const text = raw.replace(/^﻿/, "");
  const lines = text.split(/\r\n|\r|\n/);
  // Drop trailing blank lines.
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();

  const nonEmpty = lines.filter((l) => l.trim() !== "");
  if (nonEmpty.length === 0) return { ok: false, reason: "The file is empty." };
  if (nonEmpty.length > MAX_VCARD_LINES) {
    return {
      ok: false,
      reason: "The contact card has too many lines to be a valid card.",
    };
  }

  const begins = nonEmpty.filter((l) => l.trim().toUpperCase() === "BEGIN:VCARD");
  const ends = nonEmpty.filter((l) => l.trim().toUpperCase() === "END:VCARD");
  if (begins.length !== 1 || ends.length !== 1) {
    return {
      ok: false,
      reason:
        "A contact card must contain exactly one BEGIN:VCARD and one END:VCARD.",
    };
  }
  if (nonEmpty[0].trim().toUpperCase() !== "BEGIN:VCARD") {
    return { ok: false, reason: "The card must start with BEGIN:VCARD." };
  }
  if (nonEmpty[nonEmpty.length - 1].trim().toUpperCase() !== "END:VCARD") {
    return { ok: false, reason: "The card must end with END:VCARD." };
  }

  const version = nonEmpty.find((l) => /^VERSION:/i.test(l.trim()));
  if (!version || !/^VERSION:\s*(3\.0|4\.0)\s*$/i.test(version.trim())) {
    return {
      ok: false,
      reason: "The card must declare VERSION:3.0 or VERSION:4.0.",
    };
  }

  const fnLine = nonEmpty.find((l) => /^FN[;:]/i.test(l.trim()));
  let formattedName = "";
  if (fnLine) {
    formattedName = fnLine.slice(fnLine.indexOf(":") + 1).trim();
  }
  if (!formattedName) {
    // Try to build one from an N (structured name) line.
    const nLine = nonEmpty.find((l) => /^N[;:]/i.test(l.trim()));
    if (nLine) {
      const parts = nLine
        .slice(nLine.indexOf(":") + 1)
        .split(";")
        .map((p) => p.trim())
        .filter(Boolean);
      // N is Family;Given;... — present as "Given Family".
      formattedName = [parts[1], parts[0]].filter(Boolean).join(" ").trim();
    }
  }
  if (!formattedName) {
    return {
      ok: false,
      reason: "The card must include a formatted name (FN).",
    };
  }

  const normalized = `${nonEmpty.join("\r\n")}\r\n`;
  return { ok: true, normalized, formattedName };
}

/**
 * Parsed fields pulled off a stored vCard for the printable signature (spec
 * 0009). Everything is a plain display string ("" when the card omits it); the
 * `.vcf` in R2 stays the single source of truth, so nothing here is persisted.
 */
export interface ParsedVcard {
  fullName: string;
  firstName: string;
  lastName: string;
  organization: string;
  title: string;
  email: string;
  mobilePhone: string;
  workPhone: string;
  fax: string;
  website: string;
  address: {
    street: string;
    city: string;
    state: string;
    zip: string;
    country: string;
    /** A one-line "Street, City, State Zip, Country" for display; "" if empty. */
    formatted: string;
  };
}

interface VcardLine {
  name: string;
  params: Record<string, string[]>;
  value: string;
}

/** Undo the RFC 6350 escaping applied on write (`\n \, \; \\`). */
function unescapeVcard(value: string): string {
  return value.replace(/\\([\\,;nN])/g, (_, ch: string) =>
    ch === "n" || ch === "N" ? "\n" : ch,
  );
}

/** Split a structured value on unescaped semicolons, then unescape each part. */
function structured(value: string): string[] {
  const parts: string[] = [];
  let cur = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "\\" && i + 1 < value.length) {
      cur += c + value[i + 1];
      i++;
    } else if (c === ";") {
      parts.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts.map(unescapeVcard);
}

/** Unfold continuation lines (a leading space/tab continues the line above). */
function unfold(raw: string): string[] {
  const text = raw.replace(/^﻿/, "");
  const out: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** Parse one content line into name + params + raw value, or null if malformed. */
function parseLine(line: string): VcardLine | null {
  const colon = line.indexOf(":");
  if (colon === -1) return null;
  const segs = line.slice(0, colon).split(";");
  // Drop any grouping prefix ("item1.TEL" → "TEL").
  let name = segs[0];
  const dot = name.indexOf(".");
  if (dot !== -1) name = name.slice(dot + 1);
  name = name.trim().toUpperCase();

  const params: Record<string, string[]> = {};
  for (let i = 1; i < segs.length; i++) {
    const seg = segs[i];
    const eq = seg.indexOf("=");
    if (eq === -1) {
      // vCard 2.1 bare type param, e.g. "TEL;CELL;VOICE:".
      (params.TYPE ??= []).push(seg.trim().toUpperCase());
    } else {
      const key = seg.slice(0, eq).trim().toUpperCase();
      const vals = seg
        .slice(eq + 1)
        .split(",")
        .map((v) => v.trim().toUpperCase());
      (params[key] ??= []).push(...vals);
    }
  }
  return { name, params, value: line.slice(colon + 1) };
}

/**
 * Pretty-print a stored phone number for display. Cards store NANP numbers as
 * `1##########` (optionally `,,<ext>`); render `(AAA) BBB-CCCC ext. N`. Anything
 * that doesn't match is returned trimmed, unchanged.
 */
export function formatPhoneDisplay(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const [num, , ext] = trimmed.split(",");
  const digits = num.replace(/\D/g, "");
  // No digits at all → not a real number (e.g. an empty Excel cell exported as
  // "nan", or "N/A"). Treat as absent so the caller drops the line entirely.
  if (digits.length === 0) return "";
  let base = num.trim();
  if (digits.length === 11 && digits[0] === "1") {
    base = `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  } else if (digits.length === 10) {
    base = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return ext ? `${base} x${ext}` : base;
}

/**
 * Parse a stored vCard (3.0/4.0) into the display fields the signature needs
 * (spec 0009). Line folding is undone, values are unescaped, phone numbers are
 * classified by TYPE (fax → cell/mobile → work → first spare), and the address
 * is both split and pre-joined. Never throws — missing fields come back "".
 */
export function parseVcard(raw: string): ParsedVcard {
  const lines = unfold(raw)
    .map(parseLine)
    .filter((l): l is VcardLine => l !== null);

  const first = (nameUpper: string) =>
    lines.find((l) => l.name === nameUpper);

  const fnLine = first("FN");
  let fullName = fnLine ? unescapeVcard(fnLine.value).trim() : "";

  const nLine = first("N");
  let firstName = "";
  let lastName = "";
  if (nLine) {
    const [family, given] = structured(nLine.value);
    lastName = (family ?? "").trim();
    firstName = (given ?? "").trim();
  }
  if (!fullName) {
    fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  }
  if (!firstName && !lastName && fullName) {
    const bits = fullName.split(/\s+/);
    firstName = bits[0] ?? "";
    lastName = bits.slice(1).join(" ");
  }

  const orgLine = first("ORG");
  // ORG is structured (Org;Unit;…) — take the first component.
  const organization = orgLine ? (structured(orgLine.value)[0] ?? "").trim() : "";

  const titleLine = first("TITLE");
  const title = titleLine ? unescapeVcard(titleLine.value).trim() : "";

  // EMAIL: prefer a WORK-typed one, else the first present.
  const emails = lines.filter((l) => l.name === "EMAIL");
  const emailLine =
    emails.find((l) => (l.params.TYPE ?? []).includes("WORK")) ?? emails[0];
  const email = emailLine ? unescapeVcard(emailLine.value).trim() : "";

  // TEL: classify by TYPE. FAX wins first, then cell/mobile, then work; an
  // untyped number fills the first empty slot (work, then mobile).
  let mobilePhone = "";
  let workPhone = "";
  let fax = "";
  for (const tel of lines.filter((l) => l.name === "TEL")) {
    const types = tel.params.TYPE ?? [];
    const value = formatPhoneDisplay(unescapeVcard(tel.value));
    if (!value) continue;
    if (types.includes("FAX")) {
      if (!fax) fax = value;
    } else if (types.includes("CELL") || types.includes("MOBILE")) {
      if (!mobilePhone) mobilePhone = value;
    } else if (types.includes("WORK")) {
      if (!workPhone) workPhone = value;
    } else if (!workPhone) {
      workPhone = value;
    } else if (!mobilePhone) {
      mobilePhone = value;
    }
  }

  // URL: prefer a WORK-typed one, else the first present.
  const urls = lines.filter((l) => l.name === "URL");
  const urlLine =
    urls.find((l) => (l.params.TYPE ?? []).includes("WORK")) ?? urls[0];
  const website = urlLine ? unescapeVcard(urlLine.value).trim() : "";

  // ADR: POBox;Ext;Street;City;State;Zip;Country.
  const adrLine = lines.find((l) => l.name === "ADR");
  const adr = adrLine ? structured(adrLine.value) : [];
  const street = (adr[2] ?? "").trim();
  const city = (adr[3] ?? "").trim();
  const state = (adr[4] ?? "").trim();
  const zip = (adr[5] ?? "").trim();
  const country = (adr[6] ?? "").trim();
  const cityLine = [city, [state, zip].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
  const formatted = [street, cityLine, country].filter(Boolean).join(", ");

  return {
    fullName,
    firstName,
    lastName,
    organization,
    title,
    email,
    mobilePhone,
    workPhone,
    fax,
    website,
    address: { street, city, state, zip, country, formatted },
  };
}

/**
 * A url-safe slug from a contact name (spec 0003 AC-8, revised in 0006): accents
 * stripped, non-alphanumerics collapsed to single underscores, trimmed, cut to
 * 60 — giving `First_Last` and preserving case (e.g. "Jay Clark" → "Jay_Clark").
 * Uniqueness (and collision suffixing) is handled by the caller against the DB.
 */
export function deriveSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^A-Za-z0-9]+/g, "_") // non-alphanumerics → underscore
    .replace(/^_+|_+$/g, "")
    .slice(0, 60)
    .replace(/_+$/g, "");
  return slug || "contact";
}
