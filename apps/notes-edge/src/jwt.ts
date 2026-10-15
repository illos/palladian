/**
 * Short-lived ES256 JWTs naming an agent and its connection, which Convex
 * verifies through its `customJwt` provider (applicationID "palladian-convex").
 * Convex still checks on every call that the connection is active.
 */

export const AGENT_JWT_AUDIENCE = "palladian-convex";
export const AGENT_JWT_LIFETIME_SECONDS = 300;

interface SigningKey {
  key: CryptoKey;
  kid: string;
}

// One import per isolate; re-imported only if the secret changes.
let cached: { source: string; key: Promise<SigningKey> } | undefined;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeSegment(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

async function importSigningKey(source: string): Promise<SigningKey> {
  let jwk: JsonWebKey & { kid?: unknown };
  try {
    jwk = JSON.parse(source) as JsonWebKey & { kid?: unknown };
  } catch {
    // Never echo the secret's contents.
    throw new Error("AGENT_JWT_PRIVATE_KEY is not valid JSON.");
  }
  if (
    jwk.kty !== "EC" ||
    jwk.crv !== "P-256" ||
    typeof jwk.d !== "string" ||
    typeof jwk.kid !== "string" ||
    !jwk.kid
  )
    throw new Error(
      "AGENT_JWT_PRIVATE_KEY must be a private P-256 JWK with a kid.",
    );
  const { kid, ...material } = jwk;
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: material.kty, crv: material.crv, x: material.x, y: material.y, d: material.d },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return { key, kid };
}

function signingKey(source: string): Promise<SigningKey> {
  if (!source) throw new Error("AGENT_JWT_PRIVATE_KEY is not configured.");
  if (cached?.source !== source) {
    const key = importSigningKey(source);
    cached = { source, key };
    // A failed import must not stay cached.
    key.catch(() => {
      if (cached?.key === key) cached = undefined;
    });
  }
  return cached.key;
}

export interface AgentJwtInput {
  privateKey: string;
  issuer: string;
  agentId: string;
  connectionId: string;
  /** Seconds since the epoch; defaults to now. */
  now?: number;
}

export async function mintAgentJwt(input: AgentJwtInput): Promise<string> {
  if (!input.issuer) throw new Error("AGENT_JWT_ISSUER is not configured.");
  const { key, kid } = await signingKey(input.privateKey);
  const iat = input.now ?? Math.floor(Date.now() / 1000);
  const header = encodeSegment({ alg: "ES256", typ: "JWT", kid });
  const payload = encodeSegment({
    iss: input.issuer,
    aud: AGENT_JWT_AUDIENCE,
    sub: input.agentId,
    cid: input.connectionId,
    iat,
    exp: iat + AGENT_JWT_LIFETIME_SECONDS,
  });
  const signingInput = `${header}.${payload}`;
  // Web Crypto ECDSA signatures are already the IEEE P1363 r||s form JWS uses.
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}
