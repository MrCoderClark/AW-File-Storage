// AES-GCM encryption for secrets stored in D1 (spec 0013). D1 has no encryption
// at rest, so a per-org Office 365 client secret / certificate private key is
// encrypted here before it is written, and decrypted server-side only when a sync
// or a save-and-test needs it. The key (KEK) is the `O365_CRED_KEK` Worker secret
// (a base64 32-byte AES key); it never enters the database. All via Web Crypto —
// there is no Node `crypto` on Workers.

export interface SealedSecret {
  /** base64url of the random 12-byte IV. */
  iv: string;
  /** base64url of the AES-GCM ciphertext (includes the auth tag). */
  ct: string;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Returns a Uint8Array backed by a concrete ArrayBuffer (not ArrayBufferLike), so
// it satisfies Web Crypto's BufferSource parameter type under the DOM lib.
function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Import the base64 (standard or url-safe) KEK into an AES-GCM CryptoKey. */
async function importKek(kek: string): Promise<CryptoKey> {
  const raw = b64urlDecode(kek.trim());
  if (raw.byteLength !== 32) {
    throw new Error("O365_CRED_KEK must decode to 32 bytes (a base64 AES-256 key).");
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Encrypt a UTF-8 string with the KEK. Fresh random IV per call. */
export async function encryptSecret(
  kek: string,
  plaintext: string,
): Promise<SealedSecret> {
  const key = await importKek(kek);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { iv: b64urlEncode(iv), ct: b64urlEncode(new Uint8Array(ct)) };
}

/** Decrypt a sealed secret. Throws if the KEK is wrong or the data is tampered. */
export async function decryptSecret(
  kek: string,
  sealed: SealedSecret,
): Promise<string> {
  const key = await importKek(kek);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64urlDecode(sealed.iv) },
    key,
    b64urlDecode(sealed.ct),
  );
  return new TextDecoder().decode(plain);
}
