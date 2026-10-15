#!/usr/bin/env node
// Generate the ES256 key pair that signs agent JWTs.
//
//   node scripts/keygen.mjs <private-jwk-file> <public-jwks-file>
//
// Writes, with mode 0600 and refusing to overwrite:
//   <private-jwk-file>  the private JWK (one line of JSON) for the Worker secret
//                       AGENT_JWT_PRIVATE_KEY
//   <public-jwks-file>  the public JWKS as a data: URI for Convex's AGENT_JWT_JWKS
// The private key is never printed.
import { webcrypto } from "node:crypto";
import { existsSync } from "node:fs";
import { open } from "node:fs/promises";

const [privatePath, publicPath] = process.argv.slice(2);
if (!privatePath || !publicPath || privatePath === publicPath) {
  console.error(
    "Usage: node scripts/keygen.mjs <private-jwk-file> <public-jwks-file>",
  );
  process.exit(2);
}
for (const path of [privatePath, publicPath])
  if (existsSync(path)) {
    console.error(`${path} already exists; refusing to replace a key.`);
    process.exit(1);
  }

const { privateKey, publicKey } = await webcrypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);
const privateJwk = await webcrypto.subtle.exportKey("jwk", privateKey);
const publicJwk = await webcrypto.subtle.exportKey("jwk", publicKey);
const kid = Buffer.from(webcrypto.getRandomValues(new Uint8Array(12))).toString(
  "base64url",
);

const secret = JSON.stringify({
  kty: privateJwk.kty,
  x: privateJwk.x,
  y: privateJwk.y,
  crv: privateJwk.crv,
  d: privateJwk.d,
  kid,
  alg: "ES256",
});
const jwks = JSON.stringify({
  keys: [
    {
      kty: publicJwk.kty,
      x: publicJwk.x,
      y: publicJwk.y,
      crv: publicJwk.crv,
      kid,
      alg: "ES256",
      use: "sig",
    },
  ],
});
const dataUri =
  "data:text/plain;charset=utf-8;base64," +
  Buffer.from(jwks).toString("base64");

async function writeNew(path, contents) {
  // "wx": fail if the file exists, so a key is never silently replaced.
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(contents + "\n");
  } finally {
    await file.close();
  }
}

await writeNew(privatePath, secret);
await writeNew(publicPath, dataUri);
console.log(
  `Wrote the private JWK to ${privatePath} and the public JWKS data URI to ${publicPath} (kid ${kid}).`,
);
console.log("Next: wrangler secret put AGENT_JWT_PRIVATE_KEY < " + privatePath);
console.log(
  '      npx convex env set AGENT_JWT_JWKS "$(cat ' +
    publicPath +
    ')"   (from apps/notes-backend)',
);
