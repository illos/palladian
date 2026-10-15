import { describe, expect, it } from "vitest";
import { AGENT_JWT_AUDIENCE, mintAgentJwt } from "../src/jwt.ts";

async function keyPair(kid: string) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const secret = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d, kid, alg: "ES256" });
  return { secret, publicKey: pair.publicKey };
}

function decode(segment: string): Record<string, unknown> {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(base64)) as Record<string, unknown>;
}

function bytes(segment: string): Uint8Array {
  const binary = atob(segment.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function verifies(jwt: string, publicKey: CryptoKey): Promise<boolean> {
  const [header, payload, signature] = jwt.split(".");
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    bytes(signature!),
    new TextEncoder().encode(`${header}.${payload}`),
  );
}

describe("mintAgentJwt", () => {
  it("signs an ES256 JWT naming the agent and connection for Convex", async () => {
    const { secret, publicKey } = await keyPair("kid-one");
    const jwt = await mintAgentJwt({
      privateKey: secret,
      issuer: "https://palladian.example.workers.dev",
      agentId: "agent123",
      connectionId: "conn456",
      now: 1_800_000_000,
    });
    const [header, payload] = jwt.split(".");
    expect(decode(header!)).toEqual({ alg: "ES256", typ: "JWT", kid: "kid-one" });
    expect(decode(payload!)).toEqual({
      iss: "https://palladian.example.workers.dev",
      aud: AGENT_JWT_AUDIENCE,
      sub: "agent123",
      cid: "conn456",
      iat: 1_800_000_000,
      exp: 1_800_000_300,
    });
    expect(AGENT_JWT_AUDIENCE).toBe("palladian-convex");
    expect(bytes(jwt.split(".")[2]!)).toHaveLength(64);
    expect(await verifies(jwt, publicKey)).toBe(true);
  });

  it("re-imports when the secret changes", async () => {
    const first = await keyPair("kid-a");
    const second = await keyPair("kid-b");
    const input = { issuer: "http://localhost:8787", agentId: "a", connectionId: "c" };
    const one = await mintAgentJwt({ ...input, privateKey: first.secret });
    const two = await mintAgentJwt({ ...input, privateKey: second.secret });
    expect(await verifies(one, first.publicKey)).toBe(true);
    expect(await verifies(two, second.publicKey)).toBe(true);
    expect(await verifies(two, first.publicKey)).toBe(false);
    expect(decode(two.split(".")[0]!).kid).toBe("kid-b");
  });

  it("rejects unusable keys without echoing the secret", async () => {
    const input = { issuer: "http://localhost:8787", agentId: "a", connectionId: "c" };
    const notJson = "not-json-SECRETVALUE";
    await expect(mintAgentJwt({ ...input, privateKey: notJson })).rejects.toThrow(
      /^AGENT_JWT_PRIVATE_KEY is not valid JSON\.$/,
    );
    const { secret } = await keyPair("kid");
    const withoutKid = JSON.stringify({ ...JSON.parse(secret), kid: undefined });
    const error = await mintAgentJwt({ ...input, privateKey: withoutKid }).catch((e: unknown) => e);
    expect(String(error)).toMatch(/must be a private P-256 JWK with a kid/);
    expect(String(error)).not.toContain(JSON.parse(secret).d);
    await expect(mintAgentJwt({ ...input, privateKey: "" })).rejects.toThrow(/not configured/);
    await expect(mintAgentJwt({ ...input, issuer: "", privateKey: secret })).rejects.toThrow(/ISSUER/);
  });
});
