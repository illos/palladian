import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ConvexHttpClient } from "convex/browser";
import { fileURLToPath } from "node:url";
import { api } from "./convex/_generated/api.js";
const cli = "/srv/presidium/projects/palladian/code/node_modules/.bin/convex";
const origin = "http://localhost:5178";
const site = "http://127.0.0.1:3219";
const email = `proof-${randomBytes(8).toString("hex")}@example.invalid`;
const password = randomBytes(24).toString("hex");
const fixture = spawnSync(
  cli,
  ["run", "auth:fixture", JSON.stringify({ email, password })],
  { encoding: "utf8", cwd: fileURLToPath(new URL(".", import.meta.url)) },
);
assert.equal(fixture.status, 0, "internal disposable fixture provisioning");
const deniedSignup = await fetch(`${site}/api/auth/sign-up/email`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({
    email: `second-${email}`,
    password,
    name: "No public signup",
  }),
});
assert.ok(deniedSignup.status >= 400, "public signup denied");
const response = await fetch(`${site}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ email, password }),
});
assert.equal(response.status, 200, "real email/password sign-in");
const cookies = response.headers
  .getSetCookie()
  .map((x) => x.split(";")[0])
  .join("; ");
assert.ok(cookies, "session cookie provided");
async function request(path) {
  const r = await fetch(`${site}/api/auth/${path}`, {
    headers: { origin, cookie: cookies },
  });
  assert.equal(r.status, 200, `${path} request accepted`);
  return r.json();
}
const session = await request("get-session");
assert.ok(session.session, "real session persisted");
const firstToken = await request("convex/token");
assert.ok(firstToken.token, "Convex JWT provided");
const client = new ConvexHttpClient("http://127.0.0.1:3218");
client.setAuth(firstToken.token);
assert.equal(
  await client.query(api.auth.identity, {}),
  session.user.id,
  "protected query bound to signed-in account",
);
const before = JSON.parse(
  Buffer.from(firstToken.token.split(".")[1], "base64url"),
);
await new Promise((resolve) => setTimeout(resolve, 6500));
const secondToken = await request("convex/token");
const after = JSON.parse(
  Buffer.from(secondToken.token.split(".")[1], "base64url"),
);
assert.ok(
  after.exp > before.exp,
  "short-lived access token renewed from persisted session",
);
client.setAuth(secondToken.token);
assert.equal(await client.query(api.auth.identity, {}), session.user.id);
assert.ok(
  (await request("get-session")).session,
  "JWT expiry did not sign out session",
);
const outsider = new ConvexHttpClient("http://127.0.0.1:3218");
await assert.rejects(
  outsider.query(api.auth.identity, {}),
  "unauthenticated caller rejected",
);
console.log(
  "PASS: public signup denied; real password login; persisted session; protected identity; access-token expiry and renewal; unauthenticated denial.",
);
