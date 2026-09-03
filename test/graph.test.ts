import { beforeAll, describe, expect, it } from "vitest";
import {
  buildClientAssertion,
  type GraphEnv,
  graphConfigured,
  usesCertificate,
} from "../src/server/graph";

// base64url helpers for decoding the JWT in the test.
function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}
function derToPem(der: ArrayBuffer, label: string): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN ${label}-----\n${b64.replace(/(.{64})/g, "$1\n")}\n-----END ${label}-----`;
}

let CERT_ENV: GraphEnv;
let keyPair: CryptoKeyPair;

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  CERT_ENV = {
    GRAPH_TENANT_ID: "11111111-1111-1111-1111-111111111111",
    GRAPH_CLIENT_ID: "22222222-2222-2222-2222-222222222222",
    GRAPH_CLIENT_CERT_PRIVATE_KEY: derToPem(pkcs8, "PRIVATE KEY"),
    GRAPH_CLIENT_CERT_THUMBPRINT: "aabbccddeeff00112233445566778899aabbccdd", // 40 hex
  };
});

describe("credential selection", () => {
  it("usesCertificate only when both cert fields are set", () => {
    expect(usesCertificate(CERT_ENV)).toBe(true);
    expect(usesCertificate({ ...CERT_ENV, GRAPH_CLIENT_CERT_PRIVATE_KEY: undefined })).toBe(false);
    expect(usesCertificate({ GRAPH_CLIENT_SECRET: "s" })).toBe(false);
  });

  it("graphConfigured accepts a certificate OR a secret, needs tenant+client", () => {
    expect(graphConfigured(CERT_ENV)).toBe(true); // cert, no secret
    expect(
      graphConfigured({ GRAPH_TENANT_ID: "t", GRAPH_CLIENT_ID: "c", GRAPH_CLIENT_SECRET: "s" }),
    ).toBe(true); // secret, no cert
    expect(graphConfigured({ GRAPH_TENANT_ID: "t", GRAPH_CLIENT_ID: "c" })).toBe(false); // neither
    expect(graphConfigured(CERT_ENV) && !CERT_ENV.GRAPH_CLIENT_SECRET).toBe(true);
  });
});

describe("buildClientAssertion", () => {
  it("produces a well-formed, correctly-signed RS256 JWT", async () => {
    const jwt = await buildClientAssertion(CERT_ENV);
    const [h, p, sig] = jwt.split(".");
    expect(sig).toBeTruthy();

    const header = JSON.parse(b64urlDecode(h));
    const payload = JSON.parse(b64urlDecode(p));

    // Header: RS256 + the base64url x5t (the 40-hex thumbprint → 20 bytes → 27 b64url chars).
    expect(header.alg).toBe("RS256");
    expect(header.typ).toBe("JWT");
    expect(header.x5t).toMatch(/^[A-Za-z0-9_-]{27}$/);

    // Payload: aud = the tenant token endpoint, iss = sub = client id, short-lived.
    expect(payload.aud).toBe(
      "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/oauth2/v2.0/token",
    );
    expect(payload.iss).toBe(CERT_ENV.GRAPH_CLIENT_ID);
    expect(payload.sub).toBe(CERT_ENV.GRAPH_CLIENT_ID);
    expect(payload.jti).toBeTruthy();
    expect(payload.exp).toBeGreaterThan(payload.iat);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(300);

    // The signature verifies against the public key over "header.payload".
    const sigBytes = Uint8Array.from(b64urlDecode(sig), (ch) => ch.charCodeAt(0));
    const ok = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      keyPair.publicKey,
      sigBytes,
      new TextEncoder().encode(`${h}.${p}`),
    );
    expect(ok).toBe(true);
  });
});
