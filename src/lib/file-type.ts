// Derive a coarse file category from name / content type, for the type icon and
// the "Filter by type" control (spec 0007).

export type FileCategory =
  | "vcard"
  | "pdf"
  | "image"
  | "document"
  | "archive"
  | "other";

export const CATEGORY_LABEL: Record<FileCategory, string> = {
  vcard: "Contact card",
  pdf: "PDF",
  image: "Image",
  document: "Document",
  archive: "Archive",
  other: "Other",
};

const IMAGE = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic", "ico"];
const DOC = ["doc", "docx", "txt", "rtf", "xls", "xlsx", "ppt", "pptx", "csv", "odt", "md"];
const ARCHIVE = ["zip", "rar", "7z", "gz", "tar", "bz2", "xz"];

export function fileCategory(
  name: string,
  contentType = "",
  kind = "",
): FileCategory {
  if (kind === "vcard") return "vcard";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const ct = contentType.toLowerCase();

  if (ext === "vcf" || ct.includes("vcard")) return "vcard";
  if (ext === "pdf" || ct.includes("pdf")) return "pdf";
  if (IMAGE.includes(ext) || ct.startsWith("image/")) return "image";
  if (
    DOC.includes(ext) ||
    ct.includes("word") ||
    ct.includes("spreadsheet") ||
    ct.includes("sheet") ||
    ct.includes("presentation") ||
    ct.startsWith("text/")
  ) {
    return "document";
  }
  if (
    ARCHIVE.includes(ext) ||
    ct.includes("zip") ||
    ct.includes("compressed") ||
    ct.includes("tar")
  ) {
    return "archive";
  }
  return "other";
}
