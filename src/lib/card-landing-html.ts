import type { ParsedVcard } from "@/server/vcard";
import type { SignatureBrand, Socials } from "./signature-brand";

// The public contact-card landing page (spec 0008) as ONE self-contained HTML
// document: inline styles, no client JavaScript, mobile first. A person who
// scans a QR or opens the link gets the contact's details, tap-to-call phones,
// email, address, social links, and a one-tap "Add to contacts" that downloads
// the `.vcf`. Built as a plain string (like the email signature) so it renders
// identically wherever it is served, with no Tailwind bundle or hydration.

export interface CardLandingInput {
  card: ParsedVcard;
  /** The `.vcf` download href (the counted download route). */
  vcfUrl: string;
  /** The `.pdf` href: the same card as a one-page printable/saveable PDF. */
  pdfUrl: string;
  /** Absolute URL of the hosted QR image. */
  qrUrl: string;
  /** Absolute logo URL for this card's state. */
  logoUrl: string;
  /** Absolute app origin (no trailing slash) — hosts the social icons. */
  baseUrl: string;
  /** This landing page's own absolute URL (canonical + OG). */
  canonicalUrl: string;
  /** Resolved social links for this card's state. */
  socials: Socials;
  brand: SignatureBrand;
}

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

/** `tel:` href from a display number (digits only; extension after `x`). */
function telHref(display: string): string {
  const [num, ext] = display.split(/\s*x/i);
  const digits = num.replace(/\D/g, "");
  return `tel:${digits}${ext ? `,${ext.replace(/\D/g, "")}` : ""}`;
}

/** One tappable contact row: a label and a linked value. "" when no value. */
function contactRow(
  label: string,
  value: string,
  href: string,
  brand: SignatureBrand,
): string {
  if (!value) return "";
  return `<div class="row"><span class="label">${esc(label)}</span><a class="value" href="${esc(href)}">${esc(value)}</a></div>`;
}

/** The social icon row for the card's state; icons hidden when no URL is set. */
function socialRow(input: CardLandingInput): string {
  const { socials, baseUrl } = input;
  const icons: string[] = [];
  for (const key of ["facebook", "x", "instagram", "linkedin"] as const) {
    const href = socials[key];
    if (!href) continue;
    icons.push(
      `<a href="${esc(href)}" class="social"><img src="${esc(`${baseUrl}/social/${SOCIAL_ICON[key]}`)}" width="32" height="32" alt="${esc(SOCIAL_LABEL[key])}" /></a>`,
    );
  }
  if (icons.length === 0) return "";
  return `<div class="socials">${icons.join("")}</div>`;
}

/**
 * The full landing document. Returns a complete `<!doctype html>` page. The page
 * itself carries `noindex` (both a meta tag and, from the route, an
 * `X-Robots-Tag` header) because the data is real people's contact details, and
 * OG/Twitter tags so a link pasted into chat unfurls with the person's name.
 */
export function buildCardLandingHtml(input: CardLandingInput): string {
  const { card, vcfUrl, pdfUrl, qrUrl, logoUrl, canonicalUrl, brand } = input;
  const c = brand;

  const subtitle = [card.title, card.organization].filter(Boolean).join(" · ");
  const addr = card.address;
  const mapHref = addr.formatted
    ? `https://maps.google.com/?q=${encodeURIComponent(addr.formatted)}`
    : "";
  const cityLine = [addr.city, [addr.state, addr.zip].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");

  const contacts = [
    contactRow("Work", card.workPhone, telHref(card.workPhone), c),
    contactRow("Mobile", card.mobilePhone, telHref(card.mobilePhone), c),
    card.fax ? contactRow("Fax", card.fax, telHref(card.fax), c) : "",
    contactRow("Email", card.email, card.email ? `mailto:${card.email}` : "", c),
    contactRow("Web", c.websiteLabel, c.websiteUrl, c),
  ].join("");

  const addressBlock =
    addr.street || cityLine
      ? `<div class="row address"><span class="label">Address</span>${
          mapHref
            ? `<a class="value" href="${esc(mapHref)}">${[esc(addr.street), esc(cityLine)].filter(Boolean).join("<br />")}</a>`
            : `<span class="value plain">${[esc(addr.street), esc(cityLine)].filter(Boolean).join("<br />")}</span>`
        }</div>`
      : "";

  const disclaimer = c.disclaimer
    ? `<p class="disclaimer">${esc(c.disclaimer)}</p>`
    : "";

  const ogDescription = subtitle || c.companyName;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${esc(card.fullName)}${subtitle ? ` — ${esc(subtitle)}` : ""}</title>
<link rel="canonical" href="${esc(canonicalUrl)}" />
<meta property="og:type" content="profile" />
<meta property="og:title" content="${esc(card.fullName)}" />
<meta property="og:description" content="${esc(ogDescription)}" />
<meta property="og:url" content="${esc(canonicalUrl)}" />
<meta property="og:image" content="${esc(qrUrl)}" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="${esc(card.fullName)}" />
<meta name="twitter:description" content="${esc(ogDescription)}" />
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #f1f4f9;
    color: ${c.textColor};
    font-family: Arial, Helvetica, sans-serif;
    -webkit-text-size-adjust: 100%;
    padding: 24px 16px;
  }
  .card {
    max-width: 420px;
    margin: 0 auto;
    background: #ffffff;
    border-radius: 14px;
    box-shadow: 0 6px 24px rgba(31, 56, 100, 0.12);
    overflow: hidden;
  }
  .header {
    background: ${c.headingColor};
    padding: 22px 24px;
    text-align: center;
  }
  .header img { width: 150px; height: auto; display: block; margin: 0 auto; }
  .accent { height: 4px; background: ${c.accentColor}; }
  .body { padding: 22px 24px 26px; }
  .name { font-size: 22px; font-weight: bold; color: ${c.headingColor}; margin: 0; line-height: 1.2; }
  .subtitle { font-size: 14px; color: ${c.mutedColor}; margin: 4px 0 0; }
  .add {
    display: block;
    margin: 18px 0 10px;
    background: ${c.buttonColor};
    color: #ffffff;
    text-align: center;
    text-decoration: none;
    font-weight: bold;
    font-size: 15px;
    padding: 13px 16px;
    border-radius: 8px;
  }
  .save {
    display: block;
    margin: 0 0 22px;
    background: #ffffff;
    color: ${c.headingColor};
    border: 1px solid #d7dfeb;
    text-align: center;
    text-decoration: none;
    font-weight: bold;
    font-size: 14px;
    padding: 11px 16px;
    border-radius: 8px;
  }
  .row {
    display: flex;
    gap: 12px;
    padding: 9px 0;
    border-top: 1px solid #eef1f6;
    font-size: 14px;
    line-height: 1.5;
  }
  .row .label {
    flex: 0 0 62px;
    color: ${c.mutedColor};
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    padding-top: 1px;
  }
  .row .value { color: ${c.linkColor}; text-decoration: none; word-break: break-word; }
  .row .value.plain { color: ${c.textColor}; }
  .socials { display: flex; gap: 12px; justify-content: center; margin: 20px 0 4px; }
  .socials img { display: block; width: 32px; height: 32px; border: 0; }
  .qr { text-align: center; margin-top: 20px; }
  .qr img { width: 128px; height: 128px; display: inline-block; }
  .qr .caption { font-size: 11px; color: ${c.mutedColor}; margin-top: 6px; }
  .disclaimer {
    font-size: 10px;
    line-height: 1.5;
    color: ${c.mutedColor};
    margin: 20px auto 0;
    max-width: 420px;
    text-align: center;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #10141c; }
    .card { background: #1b2230; box-shadow: none; }
    .row { border-top-color: #2a3444; }
    .row .value.plain, .name { color: #e8edf5; }
    .save { background: #232c3c; color: #e8edf5; border-color: #334054; }
  }
  /* Printing the page is the poor cousin of the PDF, but if someone does it,
     don't waste ink on the grey backdrop or print the two buttons. */
  @media print {
    body { background: #ffffff; padding: 0; }
    .card { box-shadow: none; max-width: none; }
    .add, .save { display: none; }
  }
</style>
</head>
<body>
  <main class="card">
    <div class="header"><img src="${esc(logoUrl)}" alt="${esc(c.companyName)}" /></div>
    <div class="accent"></div>
    <div class="body">
      <h1 class="name">${esc(card.fullName)}</h1>
      ${subtitle ? `<p class="subtitle">${esc(subtitle)}</p>` : ""}
      <a class="add" href="${esc(vcfUrl)}">Add to contacts</a>
      <a class="save" href="${esc(pdfUrl)}">Save as PDF</a>
      ${contacts}
      ${addressBlock}
      ${socialRow(input)}
      <div class="qr">
        <img src="${esc(qrUrl)}" alt="QR code linking to this contact card" />
        <div class="caption">Scan to open this card</div>
      </div>
    </div>
  </main>
  ${disclaimer}
</body>
</html>`;
}
