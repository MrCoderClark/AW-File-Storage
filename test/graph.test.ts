import { beforeAll, describe, expect, it } from "vitest";
import {
  buildClientAssertion,
  getVerifiedDomains,
  type GraphCreds,
  graphConfiguredForOrg,
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

let CERT_CREDS: GraphCreds;
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
  CERT_CREDS = {
    tenantId: "11111111-1111-1111-1111-111111111111",
    clientId: "22222222-2222-2222-2222-222222222222",
    method: "certificate",
    certPrivateKey: derToPem(pkcs8, "PRIVATE KEY"),
    certThumbprint: "aabbccddeeff00112233445566778899aabbccdd", // 40 hex
  };
});

describe("per-org credential gate (spec 0013)", () => {
  it("graphConfiguredForOrg accepts a certificate OR a secret, needs tenant+client", () => {
    expect(graphConfiguredForOrg(CERT_CREDS)).toBe(true); // cert, no secret
    expect(
      graphConfiguredForOrg({
        tenantId: "t",
        clientId: "c",
        method: "secret",
        secret: "s",
      }),
    ).toBe(true); // secret
    // Missing the secret / cert material → not configured.
    expect(
      graphConfiguredForOrg({ tenantId: "t", clientId: "c", method: "secret" }),
    ).toBe(false);
    expect(
      graphConfiguredForOrg({ ...CERT_CREDS, certPrivateKey: null }),
    ).toBe(false);
    // Missing tenant/client → not configured.
    expect(
      graphConfiguredForOrg({ tenantId: "", clientId: "c", method: "secret", secret: "s" }),
    ).toBe(false);
    expect(graphConfiguredForOrg(null)).toBe(false);
  });
});

describe("getVerifiedDomains (spec 0014)", () => {
  it("returns only the verified domains, lower-cased", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/oauth2/v2.0/token")) {
        return new Response(
          JSON.stringify({ access_token: "tok", expires_in: 3600 }),
          { status: 200 },
        );
      }
      if (u.includes("/domains")) {
        return new Response(
          JSON.stringify({
            value: [
              { id: "h2tecs.com", isVerified: true },
              { id: "unverified.example", isVerified: false },
              { id: "AW.Example", isVerified: true },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    try {
      const domains = await getVerifiedDomains({
        tenantId: "domains-test-tenant",
        clientId: "domains-test-client",
        method: "secret",
        secret: "s",
      });
      expect(domains).toEqual(["h2tecs.com", "aw.example"]);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("buildClientAssertion", () => {
  it("produces a well-formed, correctly-signed RS256 JWT", async () => {
    const jwt = await buildClientAssertion(CERT_CREDS);
    const [h, p, sig] = jwt.split(".");
    expect(sig).toBeTruthy();

    const header = JSON.parse(b64urlDecode(h));
    const payload = JSON.parse(b64urlDecode(p));

    // Header: RS256 + the base64url x5t (the 40-hex thumbprint → 20 bytes → 27 b64url chars).
    expect(header.alg).toBe("RS256");
    expect(header.typ).toBe("JWT");
    expect(header.x5t).toMatch(/^[A-Za-z0-9_-]{27}$/);

    // Payload: aud = the org's tenant token endpoint, iss = sub = client id, short-lived.
    expect(payload.aud).toBe(
      "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/oauth2/v2.0/token",
    );
    expect(payload.iss).toBe(CERT_CREDS.clientId);
    expect(payload.sub).toBe(CERT_CREDS.clientId);
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
