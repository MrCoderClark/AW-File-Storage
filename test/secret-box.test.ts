import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../src/server/secret-box";

/** A fresh base64 (standard) 32-byte KEK. */
function makeKek(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of raw) bin += String.fromCharCode(b);
  return btoa(bin);
}

describe("secret-box (spec 0013)", () => {
  it("round-trips a secret and does not store it in the clear", async () => {
    const kek = makeKek();
    const sealed = await encryptSecret(kek, "super-secret-value");
    expect(sealed.iv).toBeTruthy();
    expect(sealed.ct).toBeTruthy();
    expect(sealed.ct).not.toContain("super-secret");
    expect(await decryptSecret(kek, sealed)).toBe("super-secret-value");
  });

  it("a wrong KEK cannot decrypt", async () => {
    const sealed = await encryptSecret(makeKek(), "x");
    await expect(decryptSecret(makeKek(), sealed)).rejects.toBeTruthy();
  });

  it("rejects a KEK that is not 32 bytes", async () => {
    await expect(encryptSecret(btoa("short"), "x")).rejects.toThrow();
  });

  it("uses a fresh IV each call (ciphertext differs for the same input)", async () => {
    const kek = makeKek();
    const a = await encryptSecret(kek, "same");
    const b = await encryptSecret(kek, "same");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });
});
