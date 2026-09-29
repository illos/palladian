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
await new Promise((resolve) => setTimeout(resolve, 65_000));
await assert.rejects(
  client.query(api.auth.identity, {}),
  "original expired access token rejected after observed grace",
);
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
const { Schema } = await import("prosemirror-model");
const { Transform, Mapping, Step } = await import("prosemirror-transform");
const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", attrs: { id: { default: null } } },
    text: {},
  },
});
async function secondUser(agent = false) {
  const email = `proof-${randomBytes(8).toString("hex")}@example.invalid`,
    password = randomBytes(24).toString("hex");
  const f = spawnSync(
    cli,
    ["run", "auth:fixture", JSON.stringify({ email, password, agent })],
    { encoding: "utf8", cwd: fileURLToPath(new URL(".", import.meta.url)) },
  );
  assert.equal(f.status, 0);
  const r = await fetch(`${site}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(r.status, 200);
  const cookie = r.headers
    .getSetCookie()
    .map((x) => x.split(";")[0])
    .join("; ");
  const t = await fetch(`${site}/api/auth/convex/token`, {
    headers: { origin, cookie },
  });
  const { token } = await t.json();
  const other = new ConvexHttpClient("http://127.0.0.1:3218");
  other.setAuth(token);
  return { client: other, id: await other.query(api.auth.identity, {}) };
}
const collaborator = await secondUser();
const base = schema.nodeFromJSON({
  type: "doc",
  content: [
    {
      type: "paragraph",
      attrs: { id: "p1" },
      content: [{ type: "text", text: "Hello" }],
    },
    {
      type: "paragraph",
      attrs: { id: "p2" },
      content: [{ type: "text", text: "Second" }],
    },
  ],
});
await assert.rejects(
  client.mutation(api.notes.create, {
    content: JSON.stringify({ type: "text", text: "invalid root" }),
  }),
  "non-document root rejected",
);
const noteId = await client.mutation(api.notes.create, {
  content: JSON.stringify(base.toJSON()),
  editorId: collaborator.id,
});
const a = new Transform(base).insert(1, schema.text("A")).steps[0];
const b = new Transform(base).insert(1, schema.text("B")).steps[0];
const first = {
  noteId,
  requestId: "first",
  version: 1,
  steps: [JSON.stringify(a.toJSON())],
  deviceTime: 1000,
};
assert.equal((await client.mutation(api.notes.submit, first)).status, "synced");
const stale = await collaborator.client.mutation(api.notes.submit, {
  noteId,
  requestId: "second",
  version: 1,
  steps: [JSON.stringify(b.toJSON())],
  deviceTime: 2000,
});
assert.equal(stale.status, "needs-rebase");
const mapping = new Mapping(
  stale.steps.map((s) => Step.fromJSON(schema, JSON.parse(s)).getMap()),
);
const mapped = b.map(mapping);
assert.ok(mapped);
const second = {
  noteId,
  requestId: "second-rebased",
  version: stale.version,
  steps: [JSON.stringify(mapped.toJSON())],
  deviceTime: 2000,
};
assert.equal(
  (await collaborator.client.mutation(api.notes.submit, second)).status,
  "synced",
);
assert.deepEqual(
  await client.query(api.notes.read, { noteId }),
  await collaborator.client.query(api.notes.read, { noteId }),
);
assert.equal(
  schema.nodeFromJSON(
    JSON.parse((await client.query(api.notes.read, { noteId })).content),
  ).firstChild.textContent,
  "ABHello",
);
const receipt = await client.mutation(api.notes.submit, first);
assert.equal(receipt.replayed, true);
assert.equal(receipt.version, 2);
await assert.rejects(
  client.mutation(api.notes.submit, { ...first, deviceTime: 9999 }),
  "same request with changed payload denied",
);
const agentUser = await secondUser(true);
await client.mutation(api.notes.addEditor, { noteId, editorId: agentUser.id });
const claimGeneration = await agentUser.client.mutation(api.notes.claim, {
  noteId,
  blockId: "p1",
});
let current = await client.query(api.notes.read, { noteId });
let step = new Transform(
  schema.nodeFromJSON(JSON.parse(current.content)),
).insert(1, schema.text("X")).steps[0];
await assert.rejects(
  client.mutation(api.notes.submit, {
    noteId,
    requestId: "blocked",
    version: current.version,
    steps: [JSON.stringify(step.toJSON())],
    deviceTime: 3000,
  }),
  "actual affected claimed paragraph rejects unclaimed editor",
);
const beforeSwap = schema.nodeFromJSON(JSON.parse(current.content));
const swap = new Transform(beforeSwap).replaceWith(0, beforeSwap.content.size, [
  beforeSwap.child(1),
  beforeSwap.child(0),
]).steps[0];
await assert.rejects(
  client.mutation(api.notes.submit, {
    noteId,
    requestId: "claimed-reorder",
    version: current.version,
    steps: [JSON.stringify(swap.toJSON())],
    deviceTime: 3000,
  }),
  "reordering unchanged claimed paragraph rejected",
);
await client.mutation(api.notes.cancel, { noteId, blockId: "p1" });
const status = await agentUser.client.query(api.notes.claimStatus, {
  noteId,
  blockId: "p1",
});
assert.equal(status.cancelled, true);
assert.ok(status.generation > claimGeneration);
await assert.rejects(
  agentUser.client.mutation(api.notes.submit, {
    noteId,
    requestId: "late",
    version: current.version,
    steps: [JSON.stringify(step.toJSON())],
    deviceTime: 3000,
    claim: { blockId: "p1", generation: claimGeneration },
  }),
  "late cancelled claim fenced",
);
assert.equal(
  (await client.query(api.notes.history, { noteId })).length,
  2,
  "retry creates no duplicate history",
);
await assert.rejects(outsider.query(api.notes.read, { noteId }));
await client.mutation(api.notes.removeEditor, {
  noteId,
  editorId: collaborator.id,
});
await assert.rejects(
  collaborator.client.mutation(api.notes.submit, second),
  "access revoked before replay receipt",
);
console.log(
  "PASS: two authenticated clients, stale step rebase and convergence, receipt retry after head advances, request mutation denial, actual claimed-block enforcement, cancellation generation/status, late-write fencing, history attribution, unauthenticated denial and revoked receipt denial.",
);

await assert.rejects(
  agentUser.client.mutation(api.notes.submit, {
    noteId,
    requestId: "omitted-claim",
    version: current.version,
    steps: [JSON.stringify(step.toJSON())],
    deviceTime: 3000,
  }),
  "trusted agent cannot omit cancelled claim",
);
