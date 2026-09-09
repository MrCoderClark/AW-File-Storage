// Client-side image optimization before upload (spec 0026 AC-2). Runs only in the browser.
//
// Two things happen here so article images stay small and look right:
//  1. Cap the longest edge to what the article can actually display. The reader content column
//     is about 736px wide (the max-w-5xl row minus the 16rem details rail and the gap); ARTICLE
//     _MAX_EDGE is ~2x that, so images are crisp on high-DPI screens and never larger than the
//     container can show. Display fit itself is handled by CSS (max-width:100%).
//  2. Re-encode to WebP (when the browser supports it) even when no downscale is needed, which
//     usually cuts file size a lot (e.g. a 333 KB JPEG/PNG down to ~100 KB) at a tiny quality
//     cost. If WebP is unsupported we only re-encode while downscaling (to JPEG), otherwise the
//     original passes through so a PNG's transparency isn't flattened.
//
// GIF (possibly animated) and any non-decodable type pass through untouched; we only read their
// dimensions.

// ~2x the reader content column (~736px) for high-DPI crispness. Nothing bigger is ever shown.
export const ARTICLE_MAX_EDGE = 1500;

export interface ResizedImage {
  /** The bytes to upload (the original File, or a re-encoded Blob). */
  blob: Blob;
  /** The final MIME type (may differ from the input when re-encoded). */
  type: string;
  /** Final pixel dimensions (0 when they couldn't be read). */
  width: number;
  height: number;
  /** Final byte size. */
  size: number;
}

// Types the canvas can safely re-encode. GIF is excluded (may be animated; canvas would flatten
// it to one frame), so it passes through untouched.
const REENCODABLE = new Set(["image/png", "image/jpeg", "image/webp"]);

let webpSupport: boolean | null = null;
function supportsWebp(): boolean {
  if (webpSupport !== null) return webpSupport;
  try {
    const c = document.createElement("canvas");
    webpSupport = c.toDataURL("image/webp").startsWith("data:image/webp");
  } catch {
    webpSupport = false;
  }
  return webpSupport;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function readDimensions(file: Blob): Promise<{ width: number; height: number }> {
  try {
    const bmp = await createImageBitmap(file);
    const dims = { width: bmp.width, height: bmp.height };
    bmp.close?.();
    return dims;
  } catch {
    return { width: 0, height: 0 };
  }
}

export async function resizeImageForUpload(
  file: File,
  opts: { maxEdge?: number; quality?: number } = {},
): Promise<ResizedImage> {
  const maxEdge = opts.maxEdge ?? ARTICLE_MAX_EDGE;
  const quality = opts.quality ?? 0.82;

  const original = (width: number, height: number): ResizedImage => ({
    blob: file,
    type: file.type,
    width,
    height,
    size: file.size,
  });
  const passthrough = async (): Promise<ResizedImage> => {
    const dims = await readDimensions(file);
    return original(dims.width, dims.height);
  };

  if (!REENCODABLE.has(file.type)) return passthrough();

  let bitmap: ImageBitmap;
  try {
    // `imageOrientation: "from-image"` bakes in EXIF orientation so portrait phone shots aren't
    // drawn sideways.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return passthrough();
  }

  const ow = bitmap.width;
  const oh = bitmap.height;
  const scale = Math.min(1, maxEdge / Math.max(ow, oh));
  const downscaling = scale < 1;
  const webp = supportsWebp();

  // Already within bounds AND we can't re-encode to WebP: keep the original (no quality loss, and
  // no risk of flattening a PNG's alpha to JPEG).
  if (!downscaling && !webp) {
    bitmap.close?.();
    return original(ow, oh);
  }

  const w = Math.max(1, Math.round(ow * scale));
  const h = Math.max(1, Math.round(oh * scale));
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close?.();
    return original(ow, oh);
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const outType = webp ? "image/webp" : "image/jpeg";
  const blob = await canvasToBlob(canvas, outType, quality);
  if (!blob) return original(ow, oh);

  // If we only re-encoded (no downscale) and it somehow grew, keep the smaller original.
  if (!downscaling && blob.size >= file.size) return original(ow, oh);

  return { blob, type: outType, width: w, height: h, size: blob.size };
}
