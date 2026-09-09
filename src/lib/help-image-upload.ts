import { resizeImageForUpload } from "./image-resize";

// One shared upload path for help images (spec 0026): downscale in the browser, reserve a
// presigned PUT + create the library-owned help_image row (POST /api/help/images), then PUT the
// bytes to R2. Used by the article editor and the media library / picker so there is a single
// implementation.

export interface UploadedHelpImage {
  imageId: string;
  /** App-relative authorized serve URL to embed or reference. */
  url: string;
}

export async function uploadHelpImage(
  file: File,
): Promise<UploadedHelpImage | null> {
  try {
    const resized = await resizeImageForUpload(file);
    const res = await fetch("/api/help/images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contentType: resized.type,
        filename: file.name,
        width: resized.width,
        height: resized.height,
        size: resized.size,
      }),
    });
    if (!res.ok) return null;
    const { imageId, uploadUrl, url } = (await res.json()) as {
      imageId: string;
      uploadUrl: string;
      url: string;
    };
    const put = await fetch(uploadUrl, {
      method: "PUT",
      body: resized.blob,
      headers: { "Content-Type": resized.type },
    });
    return put.ok ? { imageId, url } : null;
  } catch {
    return null;
  }
}
