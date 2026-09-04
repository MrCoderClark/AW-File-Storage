import QRCode from "qrcode";
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
  type RGB,
} from "pdf-lib";
import type { ParsedVcard } from "@/server/vcard";
import type { SignatureBrand } from "./signature-brand";

// A saveable PDF of a published contact card, the print/keep counterpart to the
// landing page in `card-landing-html.ts`. Same artwork, same order, same brand
// colours: navy header with the state logo, red accent rule, name, title,
// contact rows, then the QR.
//
// Deliberate choices:
//  - The QR is drawn as vector squares from the raw module matrix, NOT embedded
//    as a PNG. `qrcode`'s PNG path needs zlib and already has to fall back to
//    SVG in this runtime (see /api/cards/[id]/qr), and pdf-lib cannot embed SVG.
//    Vectors dodge both problems and stay sharp at any zoom.
//  - Text uses the two standard PDF fonts, so nothing is embedded and the file
//    stays a few KB. Standard fonts are WinAnsi only, hence `latin()`.
//  - The logo is optional: if the PNG can't be fetched or decoded, the header
//    falls back to the company name in text rather than failing the download.

export interface CardPdfInput {
  card: ParsedVcard;
  brand: SignatureBrand;
  /** The card's own landing URL, encoded into the QR. */
  canonicalUrl: string;
  /** PNG or JPEG bytes of the state logo, or null to fall back to a text header. */
  logoImage: Uint8Array | null;
}

/** Letter, in PDF points (72 per inch). */
const PAGE = { w: 612, h: 792 };
const CARD = { w: 360, top: 72 };
const PAD = 22;
/**
 * The lowest effective resolution the logo may be printed at. Raise it for a
 * smaller, sharper logo; lower it for a bigger, softer one. It only constrains
 * logos too small to fill the header at this density.
 */
const MIN_LOGO_DPI = 110;

function hex(value: string): RGB {
  const h = value.replace("#", "");
  const n = parseInt(
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h,
    16,
  );
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/**
 * Standard PDF fonts only cover WinAnsi, so anything outside it would throw on
 * draw. Fold the typographic characters that actually turn up in exported
 * contact data, then drop whatever is left over.
 */
function latin(value: string): string {
  return value
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ")
    .replace(/[^\u0020-\u00FF]/g, "");
}

/** Greedy wrap to `width`, measured in the real font. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = latin(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width || !line) {
      line = next;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

interface Ctx {
  page: PDFPage;
  regular: PDFFont;
  bold: PDFFont;
  brand: SignatureBrand;
  x: number;
  /** Current baseline cursor, measured from the top of the page. */
  y: number;
}

/** Draw one label/value row with the hairline rule above it, like the web card. */
function row(ctx: Ctx, label: string, value: string | string[]): void {
  const lines = Array.isArray(value) ? value : [value];
  if (lines.length === 0 || !lines[0]) return;

  const { page, brand } = ctx;
  const innerW = CARD.w - PAD * 2;
  const labelW = 62;

  page.drawRectangle({
    x: ctx.x,
    y: PAGE.h - ctx.y,
    width: innerW,
    height: 0.75,
    color: hex("#eef1f6"),
  });
  ctx.y += 13;

  page.drawText(latin(label.toUpperCase()), {
    x: ctx.x,
    y: PAGE.h - ctx.y,
    size: 7.5,
    font: ctx.regular,
    color: hex(brand.mutedColor),
  });

  let first = true;
  for (const line of lines) {
    if (!first) ctx.y += 13;
    page.drawText(latin(line), {
      x: ctx.x + labelW,
      y: PAGE.h - ctx.y,
      size: 10,
      font: ctx.regular,
      color: hex(brand.linkColor),
    });
    first = false;
  }
  ctx.y += 11;
}

/** The QR as vector squares, centred on the card. */
function drawQr(ctx: Ctx, url: string, size: number): void {
  const qr = QRCode.create(url, { errorCorrectionLevel: "M" });
  const count = qr.modules.size;
  const data = qr.modules.data;
  const cell = size / count;
  const x0 = ctx.x + (CARD.w - PAD * 2 - size) / 2;
  const top = PAGE.h - ctx.y - size;

  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (!data[r * count + c]) continue;
      ctx.page.drawRectangle({
        x: x0 + c * cell,
        // Row 0 is the top of the QR; PDF y grows upward.
        y: top + (count - 1 - r) * cell,
        width: cell,
        height: cell,
        color: rgb(0, 0, 0),
      });
    }
  }
  ctx.y += size;
}

/**
 * Build the one page PDF for a card. Returns the raw bytes, ready to stream
 * back with `application/pdf`.
 */
export async function buildCardPdf(input: CardPdfInput): Promise<Uint8Array> {
  const { card, brand, canonicalUrl, logoImage } = input;
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE.w, PAGE.h]);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  doc.setTitle(latin(card.fullName) || "Contact card");
  doc.setSubject(latin([card.title, card.organization].filter(Boolean).join(" - ")));
  doc.setProducer("AW File Storage");
  doc.setCreator("AW File Storage");

  const cardX = (PAGE.w - CARD.w) / 2;
  const headerH = 92;

  // Header band + accent rule.
  page.drawRectangle({
    x: cardX,
    y: PAGE.h - CARD.top - headerH,
    width: CARD.w,
    height: headerH,
    color: hex(brand.headingColor),
  });
  page.drawRectangle({
    x: cardX,
    y: PAGE.h - CARD.top - headerH - 4,
    width: CARD.w,
    height: 4,
    color: hex(brand.accentColor),
  });

  let logoDrawn = false;
  if (logoImage) {
    try {
      const img = await doc
        .embedPng(logoImage)
        .catch(() => doc.embedJpg(logoImage));
      // Never enlarge a logo past MIN_LOGO_DPI: the uploaded state logos are
      // small (the NY one is 133x100), and stretching one to the full 168pt
      // renders it at ~57 DPI, visibly soft next to the vector text and QR.
      // Printing it smaller keeps it crisp, and the cap lifts by itself once a
      // higher-resolution logo is uploaded.
      const maxW = Math.min(168, (img.width * 72) / MIN_LOGO_DPI);
      const maxH = headerH - 28;
      const scale = Math.min(maxW / img.width, maxH / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      page.drawImage(img, {
        x: cardX + (CARD.w - w) / 2,
        y: PAGE.h - CARD.top - headerH + (headerH - h) / 2,
        width: w,
        height: h,
      });
      logoDrawn = true;
    } catch {
      // Fall through to the text header below.
    }
  }
  if (!logoDrawn) {
    const name = latin(brand.companyName);
    const size = 14;
    page.drawText(name, {
      x: cardX + (CARD.w - bold.widthOfTextAtSize(name, size)) / 2,
      y: PAGE.h - CARD.top - headerH / 2 - size / 3,
      size,
      font: bold,
      color: rgb(1, 1, 1),
    });
  }

  const ctx: Ctx = {
    page,
    regular,
    bold,
    brand,
    x: cardX + PAD,
    y: CARD.top + headerH + 4 + PAD + 16,
  };
  const innerW = CARD.w - PAD * 2;

  // Name + title/organization.
  page.drawText(latin(card.fullName), {
    x: ctx.x,
    y: PAGE.h - ctx.y,
    size: 18,
    font: bold,
    color: hex(brand.headingColor),
  });
  ctx.y += 16;

  const subtitle = [card.title, card.organization].filter(Boolean).join(" \u00B7 ");
  if (subtitle) {
    for (const line of wrap(subtitle, regular, 10.5, innerW)) {
      page.drawText(line, {
        x: ctx.x,
        y: PAGE.h - ctx.y,
        size: 10.5,
        font: regular,
        color: hex(brand.mutedColor),
      });
      ctx.y += 13;
    }
  }
  ctx.y += 10;

  // Contact rows, in the same order as the landing page.
  row(ctx, "Work", card.workPhone);
  row(ctx, "Mobile", card.mobilePhone);
  if (card.fax) row(ctx, "Fax", card.fax);
  row(ctx, "Email", card.email);
  row(ctx, "Web", brand.websiteLabel);

  const cityLine = [
    card.address.city,
    [card.address.state, card.address.zip].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(", ");
  const addressLines = [card.address.street, cityLine].filter(Boolean);
  if (addressLines.length > 0) row(ctx, "Address", addressLines);

  // Closing rule under the last row, then the QR.
  page.drawRectangle({
    x: ctx.x,
    y: PAGE.h - ctx.y,
    width: innerW,
    height: 0.75,
    color: hex("#eef1f6"),
  });

  ctx.y += 26;
  drawQr(ctx, canonicalUrl, 116);
  ctx.y += 14;

  const caption = "Scan to open this card";
  page.drawText(caption, {
    x: ctx.x + (innerW - regular.widthOfTextAtSize(caption, 8.5)) / 2,
    y: PAGE.h - ctx.y,
    size: 8.5,
    font: regular,
    color: hex(brand.mutedColor),
  });
  ctx.y += 14;

  const urlLine = latin(canonicalUrl);
  page.drawText(urlLine, {
    x: ctx.x + (innerW - regular.widthOfTextAtSize(urlLine, 8.5)) / 2,
    y: PAGE.h - ctx.y,
    size: 8.5,
    font: regular,
    color: hex(brand.linkColor),
  });
  ctx.y += 20;

  // Card outline, drawn last so it frames the exact height used.
  const cardBottom = PAGE.h - ctx.y;
  page.drawRectangle({
    x: cardX,
    y: cardBottom,
    width: CARD.w,
    height: PAGE.h - CARD.top - cardBottom,
    borderColor: hex("#e2e8f0"),
    borderWidth: 0.75,
  });

  // Confidentiality footer, matching the landing page.
  if (brand.disclaimer) {
    let y = cardBottom - 24;
    for (const line of wrap(brand.disclaimer, regular, 7, CARD.w)) {
      page.drawText(line, {
        x: cardX + (CARD.w - regular.widthOfTextAtSize(line, 7)) / 2,
        y,
        size: 7,
        font: regular,
        color: hex(brand.mutedColor),
      });
      y -= 9;
    }
  }

  return doc.save();
}
