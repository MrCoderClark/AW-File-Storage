/**
 * vCard validation + normalisation (spec 0003 AC-6). A card is published only if
 * it decodes as UTF-8, is a single well-formed VCARD (3.0 or 4.0) with a
 * formatted name. The normalised text (CRLF line endings, BOM stripped) is what
 * gets published, never the raw upload. Each rejection has a readable reason.
 */
export type VcardResult =
  | { ok: true; normalized: string; formattedName: string }
  | { ok: false; reason: string };

export function validateVcard(raw: string): VcardResult {
  // Strip a leading byte-order mark and normalise line endings.
  const text = raw.replace(/^﻿/, "");
  const lines = text.split(/\r\n|\r|\n/);
  // Drop trailing blank lines.
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();

  const nonEmpty = lines.filter((l) => l.trim() !== "");
  if (nonEmpty.length === 0) return { ok: false, reason: "The file is empty." };

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
