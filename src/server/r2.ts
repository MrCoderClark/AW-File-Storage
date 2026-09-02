import { AwsClient } from "aws4fetch";

/**
 * R2 presigning for direct browser transfers (spec 0003). The browser PUTs
 * upload bytes straight to the private bucket and GETs private files via short-
 * lived signed URLs, so file bytes never pass through the Worker (AC-2).
 *
 * Server-side reads/copies (HEAD at finalize, copy to the public bucket) use the
 * R2 *binding* directly (env.FILES_PRIVATE / FILES_PUBLIC), not these — only the
 * browser needs signed URLs.
 */
export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function objectUrl(cfg: R2Config, bucket: string, key: string): string {
  // Keep "/" in keys readable; encode everything else.
  const encodedKey = key
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `https://${cfg.accountId}.r2.cloudflarestorage.com/${bucket}/${encodedKey}`;
}

function client(cfg: R2Config): AwsClient {
  return new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: "s3",
    region: "auto",
  });
}

/** Presigned PUT URL scoped to exactly one key in one bucket (AC-1). */
export async function presignPut(
  cfg: R2Config,
  bucket: string,
  key: string,
  expiresInSeconds: number,
): Promise<string> {
  const url = new URL(objectUrl(cfg, bucket, key));
  url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));
  const signed = await client(cfg).sign(url.toString(), {
    method: "PUT",
    aws: { signQuery: true },
  });
  return signed.url;
}

/** Server-side HEAD: object size + content type, or null if it does not exist. */
export async function r2Head(
  cfg: R2Config,
  bucket: string,
  key: string,
): Promise<{ size: number; contentType: string | null } | null> {
  const res = await client(cfg).fetch(objectUrl(cfg, bucket, key), {
    method: "HEAD",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 HEAD failed: ${res.status}`);
  return {
    size: Number(res.headers.get("content-length") ?? 0),
    contentType: res.headers.get("content-type"),
  };
}

/** Server-side GET returning the object body as text (for vCard validation). */
export async function r2GetText(
  cfg: R2Config,
  bucket: string,
  key: string,
): Promise<string | null> {
  const res = await client(cfg).fetch(objectUrl(cfg, bucket, key), {
    method: "GET",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 GET failed: ${res.status}`);
  return res.text();
}

/**
 * Server-side GET returning the object bytes + stored content type (for serving
 * binary public objects, e.g. state logos, through the Worker). Null on 404.
 */
export async function r2GetBytes(
  cfg: R2Config,
  bucket: string,
  key: string,
): Promise<{ body: ArrayBuffer; contentType: string | null } | null> {
  const res = await client(cfg).fetch(objectUrl(cfg, bucket, key), {
    method: "GET",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 GET failed: ${res.status}`);
  return { body: await res.arrayBuffer(), contentType: res.headers.get("content-type") };
}

/** Server-side PUT with optional response headers stored on the object. */
export async function r2Put(
  cfg: R2Config,
  bucket: string,
  key: string,
  body: string | ArrayBuffer,
  headers: Record<string, string> = {},
): Promise<void> {
  // Use a presigned PUT URL + plain fetch, the same path the browser upload
  // uses. Signing the body through aws4fetch's own fetch drops the
  // Content-Length under the Node dev runtime, which R2 rejects with 411; a
  // presigned URL with a fixed-length byte body always carries the length.
  const payload = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const url = await presignPut(cfg, bucket, key, 300);
  const res = await fetch(url, { method: "PUT", body: payload, headers });
  if (!res.ok) throw new Error(`R2 PUT failed: ${res.status}`);
}

/** Server-side copy (S3 CopyObject) — no bytes pass through the Worker. */
export async function r2Copy(
  cfg: R2Config,
  bucket: string,
  destKey: string,
  srcBucket: string,
  srcKey: string,
): Promise<void> {
  const encodedSrc = srcKey
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
  const res = await client(cfg).fetch(objectUrl(cfg, bucket, destKey), {
    method: "PUT",
    headers: { "x-amz-copy-source": `/${srcBucket}/${encodedSrc}` },
  });
  if (!res.ok) throw new Error(`R2 COPY failed: ${res.status}`);
}

/** Server-side DELETE. Succeeds even if the object is already gone. */
export async function r2Delete(
  cfg: R2Config,
  bucket: string,
  key: string,
): Promise<void> {
  const res = await client(cfg).fetch(objectUrl(cfg, bucket, key), {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`R2 DELETE failed: ${res.status}`);
  }
}

/** Presigned GET URL for a private file, short-lived (AC-12). */
export async function presignGet(
  cfg: R2Config,
  bucket: string,
  key: string,
  expiresInSeconds: number,
): Promise<string> {
  const url = new URL(objectUrl(cfg, bucket, key));
  url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));
  const signed = await client(cfg).sign(url.toString(), {
    method: "GET",
    aws: { signQuery: true },
  });
  return signed.url;
}
