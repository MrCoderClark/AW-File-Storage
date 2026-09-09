// Shared data types + calls for the media library (spec 0026), used by both the /kb/media
// management screen and the in-editor MediaPicker so there is one source of truth.

export interface MediaImage {
  id: string;
  filename: string | null;
  title: string | null;
  caption: string | null;
  contentType: string;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  altText: string | null;
  inUse: boolean;
  /** Articles referencing this image (featured or in-body). */
  usedBy: { id: string; title: string }[];
  /** ISO string (serialized from the DB timestamp). */
  createdAt: string | number | null;
  /** Authorized serve URL. */
  url: string;
}

export async function fetchMediaImages(): Promise<MediaImage[]> {
  const res = await fetch("/api/help/images", { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load media");
  const body = (await res.json()) as { images?: MediaImage[] };
  return body.images ?? [];
}

export async function patchMediaImage(
  id: string,
  patch: {
    filename?: string;
    title?: string | null;
    caption?: string | null;
    alt?: string | null;
  },
): Promise<boolean> {
  const res = await fetch(`/api/help/images/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return res.ok;
}

export type DeleteMediaResult =
  | { ok: true }
  | { ok: false; inUse: boolean; articles: { id: string; title: string }[]; error: string };

export async function deleteMediaImage(id: string): Promise<DeleteMediaResult> {
  const res = await fetch(`/api/help/images/${id}`, { method: "DELETE" });
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    articles?: { id: string; title: string }[];
  };
  return {
    ok: false,
    inUse: res.status === 409,
    articles: body.articles ?? [],
    error: body.error ?? "Couldn't delete this image.",
  };
}
