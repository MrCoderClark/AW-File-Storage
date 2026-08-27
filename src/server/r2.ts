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
