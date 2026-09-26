import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { chromium } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { api } from "../../convex/_generated/api.js";
import { frontendOrigin } from "../auth/environment.mjs";

// Independent P3 public-boundary tests. The parent owns real R2 byte tests.
const env = readFileSync(".env.local", "utf8");
assert(
  env.includes("CONVEX_DEPLOYMENT=anonymous:") &&
    env.includes("http://127.0.0.1:3214"),
);
assert(!Object.keys(process.env).some((name) => name.startsWith("CONVEX_")));
console.log(
  "target: local-anonymous3214/3215; independent P3 disposable typed fixtures; no production target",
);
const p = api.platform;
const nonce = () => randomBytes(12).toString("hex");
function operator(fn, args) {
  const result = spawnSync(
    "node_modules/.bin/convex",
    ["run", "--codegen", "disable", fn, JSON.stringify(args)],
    { env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" }, stdio: "pipe" },
  );
  assert.equal(result.status, 0, "Operator fixture failed; output suppressed");
  return JSON.parse(result.stdout.toString());
}
const fixtureFlag = spawnSync(
  "node_modules/.bin/convex",
  ["env", "get", "PALLADIAN_ENABLE_P3_FIXTURES"],
  { env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" }, stdio: "pipe" },
);
assert(
  fixtureFlag.status === 0 && fixtureFlag.stdout.toString().trim() === "true",
  "Operator must explicitly enable local P3 fixtures before this test",
);
const browser = await chromium.launch();
const clients = [];
let scenario = "provision and authenticate disposable owners";
let count = 0;
function pass() {
  count++;
  console.log(`PASS ${scenario}`);
}
async function denied(promise, code = "NOT_FOUND") {
  let rejected = false;
  try {
    await promise;
  } catch (error) {
    rejected = true;
    assert(
      error instanceof ConvexError,
      "denial must be a domain error, not transport failure",
    );
    assert.equal(error.data?.code, code);
  }
  assert(rejected, "unexpectedly authorized");
}
async function account() {
  const owner = {
    email: `p3-review-${nonce()}@example.invalid`,
    password: randomBytes(32).toString("base64url"),
    name: "P3 independent fixture",
  };
  operator("provision:owner", owner);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(frontendOrigin);
  await page.getByLabel("Email", { exact: true }).fill(owner.email);
  await page.getByLabel("Password", { exact: true }).fill(owner.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByTestId("private-account").waitFor({ timeout: 30000 });
  const token = await page.evaluate(
    async () =>
      (await (await import("/src/auth/client.ts")).authClient.convex.token())
        .data?.token,
  );
  assert.equal(typeof token, "string");
  const client = new ConvexHttpClient("http://127.0.0.1:3214", {
    logger: false,
  });
  client.setAuth(token);
  clients.push(client);
  const workspace = await client.mutation(p.workspaces.ensure, {});
  return { client, workspace };
}
try {
  const a = await account(),
    b = await account();
  const A = a.client,
    B = b.client,
    wa = a.workspace,
    wb = b.workspace;
  const createInstance = (client, workspace, definitionId, title) =>
    client.mutation(p.instances.create, {
      workspaceId: workspace.id,
      definitionId,
      title,
      idempotencyKey: nonce(),
    });
  const n1 = await createInstance(A, wa, "notes", "Review notes one");
  const n2 = await createInstance(A, wa, "notes", "Review notes two");
  const r1 = await createInstance(A, wa, "recipes", "Review recipes");
  const bn = await createInstance(B, wb, "notes", "Other owner notes");
  const needle = `reviewneedle${nonce()}`;
  const fixture = (workspace, instance, suffix) =>
    operator("platform/fixtures:create", {
      workspaceId: workspace.id,
      instanceId: instance.id,
      definitionId: instance.definitionId,
      title: `${needle} ${suffix}`,
      text: `${needle} <img src=x onerror=alert(1)> fixture plain text`,
    });
  const t1 = fixture(wa, n1, "one"),
    t2 = fixture(wa, n2, "two"),
    tr = fixture(wa, r1, "recipe"),
    tb = fixture(wb, bn, "foreign");
  const search = (client, workspace, args = {}) =>
    client.query(p.search.search, {
      workspaceId: workspace.id,
      text: needle,
      cursor: null,
      ...args,
    });
  const resolve = (client, workspace, target) =>
    client.query(p.resources.resolve, { workspaceId: workspace.id, target });
  scenario =
    "S01 actual typed fixture resolver and registered scoped global search";
  const first = await search(A, wa);
  assert.equal(first.items.length, 3);
  assert.deepEqual(
    new Set(first.items.map((item) => item.target.definitionId)),
    new Set(["notes", "recipes"]),
  );
  for (const item of first.items) {
    assert.equal(item.source, "fixture");
    assert(item.href.startsWith(`/w/${wa.id}/a/${item.target.instanceId}/r/`));
    const source = await resolve(A, wa, item.target);
    assert.equal(source.source, "fixture");
    assert.equal(source.title, item.title);
    assert.equal(source.revision, item.sourceRevision);
    assert.equal(source.text.slice(0, 240), item.snippet);
  }
  assert.deepEqual(
    (await search(A, wa, { instanceId: n1.id })).items.map(
      (item) => item.target.resourceId,
    ),
    [t1.resourceId],
  );
  pass();

  scenario =
    "S02 anonymous/foreign ownership and same-definition resource swaps denied";
  const anonymous = new ConvexHttpClient("http://127.0.0.1:3214", {
    logger: false,
  });
  await denied(search(anonymous, wa), "UNAUTHENTICATED");
  await denied(resolve(anonymous, wa, t1), "UNAUTHENTICATED");
  await denied(search(B, wa));
  await denied(resolve(B, wa, t1));
  await denied(resolve(A, wa, tb));
  await denied(resolve(A, wa, { ...t1, instanceId: n2.id }));
  await denied(resolve(A, wa, { ...t1, instanceId: r1.id }));
  await denied(search(A, wa, { instanceId: bn.id }));
  assert(
    !(await search(A, wa)).items.some(
      (item) => item.target.resourceId === tb.resourceId,
    ),
  );
  assert.equal((await resolve(B, wb, tb)).source, "fixture");
  pass();

  scenario =
    "S03 delayed projection never discloses obsolete source or overwrites newer text";
  const freshNeedle = `freshneedle${nonce()}`;
  assert.equal(
    operator("platform/fixtures:update", {
      target: t1,
      title: `${freshNeedle} revised`,
      text: `${freshNeedle} latest source`,
      trashed: false,
      expectedRevision: 0,
      deferProjection: true,
    }),
    1,
  );
  assert(
    !(await search(A, wa)).items.some(
      (item) => item.target.resourceId === t1.resourceId,
    ),
  );
  assert.equal((await resolve(A, wa, t1)).revision, 1);
  assert.equal(
    operator("platform/search:project", { target: t1, revision: 0 }),
    false,
  );
  assert.equal(
    operator("platform/search:project", { target: t1, revision: 1 }),
    true,
  );
  const updated = await search(A, wa, { text: freshNeedle });
  assert.equal(updated.items.length, 1);
  assert.equal(updated.items[0].sourceRevision, 1);
  assert.equal(updated.items[0].snippet, `${freshNeedle} latest source`);
  assert.equal(
    operator("platform/search:project", { target: t1, revision: 0 }),
    false,
  );
  assert.deepEqual(
    (await search(A, wa, { text: freshNeedle })).items,
    updated.items,
  );
  pass();

  scenario =
    "S02 trash and archive hide stale projection titles/snippets immediately";
  operator("platform/fixtures:update", {
    target: t2,
    title: `${needle} trashed`,
    text: "hidden fixture",
    trashed: true,
    expectedRevision: 0,
    deferProjection: true,
  });
  await denied(resolve(A, wa, t2));
  assert(
    !(await search(A, wa)).items.some(
      (item) => item.target.resourceId === t2.resourceId,
    ),
  );
  await A.mutation(p.instances.archive, {
    workspaceId: wa.id,
    instanceId: r1.id,
    expectedRevision: 0,
  });
  await denied(resolve(A, wa, tr));
  await denied(search(A, wa, { instanceId: r1.id }));
  assert(
    !(await search(A, wa)).items.some(
      (item) => item.target.resourceId === tr.resourceId,
    ),
  );
  assert.equal((await resolve(A, wa, t1)).revision, 1);
  pass();

  scenario =
    "S04 bounded pagination tolerates filtered empty pages without scope leakage";
  const extra1 = fixture(wa, n1, "extraone"),
    extra2 = fixture(wa, n2, "extratwo");
  const seen = new Set();
  let cursor = null,
    pages = 0;
  do {
    const page = await search(A, wa, { limit: 1, cursor });
    assert(page.items.length <= 1);
    for (const item of page.items) {
      assert(!seen.has(item.target.resourceId));
      assert(
        [extra1.resourceId, extra2.resourceId].includes(item.target.resourceId),
      );
      seen.add(item.target.resourceId);
    }
    cursor = page.cursor;
    pages++;
    assert(pages < 20, "bounded small fixture traversal must terminate");
  } while (cursor);
  assert.equal(seen.size, 2);
  for (const limit of [0, -1, 51, 0.5, Infinity])
    await denied(search(A, wa, { limit }), "VALIDATION");
  for (const text of ["", "x".repeat(257)])
    await denied(search(A, wa, { text }), "VALIDATION");
  await denied(search(A, wa, { cursor: "x".repeat(4097) }), "VALIDATION");
  pass();

  scenario = "live revoked-session denial protects resources and search";
  const current = (await A.query(p.sessions.list, { cursor: null })).page.find(
    (session) => session.current,
  );
  assert(current);
  await A.action(p.sessions.revoke, { id: current.id });
  await denied(resolve(A, wa, t1), "UNAUTHENTICATED");
  await denied(search(A, wa), "UNAUTHENTICATED");
  assert.equal((await resolve(B, wb, tb)).source, "fixture");
  pass();
  console.log(
    `Completed ${count} independent actual-service P3 search groups. File lifecycle, R2 bytes and physical devices are separate pending gates.`,
  );
} catch (error) {
  console.error(`FAIL ${scenario}; fixture details suppressed.`);
  console.error(
    String(error?.stack)
      .split("\n")
      .filter((line) => line.includes("tests/files/redteam.mjs:"))
      .join("\n"),
  );
  process.exitCode = 1;
} finally {
  for (const client of clients) {
    try {
      const current = (
        await client.query(p.sessions.list, { cursor: null })
      ).page.find((session) => session.current);
      if (current) await client.action(p.sessions.revoke, { id: current.id });
    } catch {
      /* Already revoked or unavailable; never log credentials. */
    }
  }
  await browser.close();
}
