import type { ParsedVcard } from "@/server/vcard";
import type { SignatureBrand, Socials } from "./signature-brand";

// Build the America Works print/email signature as ONE self-contained HTML
// fragment (spec 0009), matching the company's Outlook signature: logo + links
// on the left, a full-height red divider, then name/title, labelled contact
// lines, a two-line address, a "Schedule a meeting" button with round social
// icons, and the QR beneath — all as nested <table>s with inline styles and
// absolute image URLs so it survives email clients. The same string drives the
// on-screen preview, so what you see is what gets copied.

export interface SignatureInput {
  card: ParsedVcard;
  /** Public vCard address, e.g. https://contacts.awvcard.com/c/First_Last.vcf */
  publicUrl: string;
  /** Absolute URL of the hosted QR image (email clients can't use data URIs). */
  qrUrl: string;
  /** Absolute app origin (no trailing slash) — hosts the logo + social icons. */
  baseUrl: string;
  /** Resolved social links for this card's state (from the org's settings). */
  socials: Socials;
  /** Resolved logo path for this card's state (from logoForState). */
  logoPath: string;
  brand: SignatureBrand;
}

/** Hosted social-icon PNGs (round; generated into public/social/). */
const SOCIAL_ICON = {
  facebook: "facebook.png",
  x: "x.png",
  instagram: "instagram.png",
  linkedin: "linkedin.png",
} as const;

const SOCIAL_LABEL = {
  facebook: "Facebook",
  x: "X",
  instagram: "Instagram",
  linkedin: "LinkedIn",
} as const;

/** Escape a value for safe inclusion in HTML text/attributes. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A blue underlined hyperlink — the signature's standard link style. */
function alink(href: string, text: string, brand: SignatureBrand): string {
  return `<a href="${esc(href)}" style="color:${brand.linkColor};text-decoration:underline;">${esc(text)}</a>`;
}

/** `tel:` href from a display number (digits only; extension after a comma). */
function telHref(display: string): string {
  const [num, ext] = display.split(/\s*x/i);
  const digits = num.replace(/\D/g, "");
  return `tel:${digits}${ext ? `,${ext.replace(/\D/g, "")}` : ""}`;
}

/** A "label: value" contact line with a bold label and a blue underlined value. */
function contactLine(
  label: string,
  value: string,
  href: string,
  brand: SignatureBrand,
): string {
  if (!value) return "";
  return `<div style="font-size:12px;line-height:1.55;color:${brand.textColor};"><strong style="color:${brand.labelColor};">${esc(label)}:</strong> ${alink(href, value, brand)}</div>`;
}

/** The "Schedule a meeting" pill button. */
function scheduleButton(brand: SignatureBrand): string {
  return `<a href="${esc(brand.scheduleMeetingUrl)}" style="display:inline-block;background:${brand.buttonColor};color:#ffffff;font-size:11px;font-weight:bold;text-decoration:none;padding:6px 14px;border-radius:4px;">Schedule a meeting</a>`;
}

/**
 * One row: the Schedule button followed by the round social icons for the card's
 * state (falling back to the org-wide set). Icons are hidden individually when
 * no URL is configured.
 */
function actionRow(input: SignatureInput): string {
  const { brand, socials, baseUrl } = input;
  const cells = [
    `<td style="padding-right:10px;vertical-align:middle;">${scheduleButton(brand)}</td>`,
  ];
  for (const key of ["facebook", "x", "instagram", "linkedin"] as const) {
    const href = socials[key];
    if (!href) continue;
    const src = `${baseUrl}/social/${SOCIAL_ICON[key]}`;
    cells.push(
      `<td style="padding-right:5px;vertical-align:middle;"><a href="${esc(href)}" style="text-decoration:none;"><img src="${esc(src)}" width="22" height="22" alt="${esc(SOCIAL_LABEL[key])}" style="display:block;width:22px;height:22px;border:0;" /></a></td>`,
    );
  }
  return `<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse:collapse;margin-top:12px;"><tr>${cells.join("")}</tr></table>`;
}

/** A blank vertical gap of the given pixel height. */
function gap(px: number): string {
  return `<div style="height:${px}px;font-size:0;line-height:0;">&nbsp;</div>`;
}

/**
 * The full signature fragment. One table row of three cells — logo, full-height
 * red divider, details — so the divider runs the whole height; the disclaimer is
 * a second full-width row beneath.
 */
export function buildSignatureHtml(input: SignatureInput): string {
  const { card, qrUrl, baseUrl, logoPath, brand } = input;
  const c = brand;
  const logoUrl = `${baseUrl}${logoPath}`;

  const audience = `${alink(c.employersUrl, "Employers", c)}<span style="color:${c.textColor};"> | </span>${alink(c.jobSeekersUrl, "Job Seekers", c)}`;

  const contactBlock = [
    contactLine("telephone", card.workPhone, telHref(card.workPhone), c),
    contactLine("mobile", card.mobilePhone, telHref(card.mobilePhone), c),
    card.fax ? contactLine("fax", card.fax, telHref(card.fax), c) : "",
    contactLine(
      "email",
      card.email,
      card.email ? `mailto:${card.email}` : "",
      c,
    ),
  ].join("");

  const addr = card.address;
  const cityLine = [addr.city, [addr.state, addr.zip].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
  const addressBlock =
    addr.street || cityLine
      ? `${gap(8)}<div style="font-size:12px;line-height:1.55;color:${c.textColor};">${[esc(addr.street), esc(cityLine)].filter(Boolean).join("<br />")}</div>`
      : "";

  const disclaimerRow = c.disclaimer
    ? `<tr><td colspan="3" style="padding-top:16px;"><div style="font-size:10px;line-height:1.45;color:${c.mutedColor};max-width:600px;">${esc(c.disclaimer)}</div></td></tr>`
    : "";

  return `<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;max-width:600px;">
  <tr>
    <!-- Left: logo + website + audience -->
    <td style="vertical-align:top;padding:0 16px 0 0;text-align:center;">
      <img src="${esc(logoUrl)}" alt="${esc(c.companyName)}" width="140" style="display:block;width:140px;height:auto;border:0;margin:0 auto;" />
      <div style="font-size:12px;margin-top:12px;">${alink(c.websiteUrl, c.websiteLabel, c)}</div>
      <div style="font-size:12px;margin-top:3px;">${audience}</div>
    </td>
    <!-- Full-height red divider -->
    <td style="width:3px;background:${c.accentColor};font-size:0;line-height:0;">&nbsp;</td>
    <!-- Right: name, contacts, address, actions, QR -->
    <td style="vertical-align:top;padding:0 0 0 16px;">
      <div style="font-size:16px;font-weight:bold;color:${c.headingColor};line-height:1.2;">${esc(card.fullName)}</div>
      ${
        card.title
          ? `<div style="font-size:13px;font-weight:bold;color:${c.headingColor};line-height:1.2;">${esc(card.title)}</div>`
          : ""
      }
      ${gap(10)}
      ${contactBlock}
      ${addressBlock}
      ${actionRow(input)}
      ${gap(12)}
      <img src="${esc(qrUrl)}" alt="QR code linking to ${esc(card.fullName)}'s contact card" width="96" height="96" style="display:block;width:96px;height:96px;border:0;" />
    </td>
  </tr>
  ${disclaimerRow}
</table>`;
}
