import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { chromium } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { api } from "../../convex/_generated/api.js";
import { frontendOrigin } from "../auth/environment.mjs";

// Independent P2 acceptance: real local backend/auth/browser, disposable metadata only.
const env = readFileSync(".env.local", "utf8");
assert(
  env.includes("CONVEX_DEPLOYMENT=anonymous:") &&
    env.includes("http://127.0.0.1:3214"),
);
assert(!Object.keys(process.env).some((key) => key.startsWith("CONVEX_")));
console.log(
  "target: local-anonymous3214/3215; disposable P2 owners/workspaces/instances/preferences; no file bytes",
);
const browser = await chromium.launch();
const accounts = [];
let scenario = "provision";
const checks = [];
const p = api.platform;
const notes = api.apps.notes.instances;
const recipes = api.apps.recipes.instances;
const key = () => randomBytes(16).toString("hex");
const scope = (workspace, instance) => ({
  workspaceId: workspace.id,
  instanceId: instance.id,
});
function pass(name) {
  checks.push(name);
  console.log(`PASS ${name}`);
}
async function denied(promise, expected = "NOT_FOUND") {
  let rejected = false;
  try {
    await promise;
  } catch (error) {
    rejected = true;
    assert(
      error instanceof ConvexError,
      "denial must be an actual domain error, not network/framework failure",
    );
    assert.equal(error.data?.code, expected);
    assert.equal(typeof error.data.message, "string");
    assert(error.data.message.length < 150);
  }
  assert(rejected, "operation unexpectedly succeeded");
}
async function frameworkRejected(promise) {
  let rejected = false;
  try {
    await promise;
  } catch (error) {
    rejected = true;
    assert(
      /ArgumentValidationError/.test(error.message),
      "must reject at argument validator, not network failure",
    );
  }
  assert(rejected);
}
async function account() {
  const owner = {
    email: `p2-review-${key()}@example.invalid`,
    password: randomBytes(32).toString("base64url"),
    name: "P2 review fixture",
  };
  const provision = spawnSync(
    "node_modules/.bin/convex",
    ["run", "--codegen", "disable", "provision:owner", JSON.stringify(owner)],
    { env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" }, stdio: "pipe" },
  );
  assert.equal(
    provision.status,
    0,
    "local fixture provisioning failed; output suppressed",
  );
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(frontendOrigin);
  await page.getByLabel("Email", { exact: true }).fill(owner.email);
  await page.getByLabel("Password", { exact: true }).fill(owner.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByTestId("private-account").waitFor({ timeout: 20000 });
  const token = await page.evaluate(async () => {
    const { authClient } = await import("/src/auth/client.ts");
    return (await authClient.convex.token()).data?.token;
  });
  assert.equal(typeof token, "string");
  const client = new ConvexHttpClient("http://127.0.0.1:3214", {
    logger: false,
  });
  client.setAuth(token);
  const result = { context, page, client };
  accounts.push(result);
  return result;
}
try {
  const a = await account();
  const b = await account();
  const A = a.client,
    B = b.client;
  scenario = "D01 concurrent default workspace and distinct owners";
  const ensured = await Promise.all(
    Array.from({ length: 6 }, () => A.mutation(p.workspaces.ensure, {})),
  );
  const wa = ensured[0],
    wb = await B.mutation(p.workspaces.ensure, {});
  assert(ensured.every((w) => w.id === wa.id));
  assert.notEqual(wa.id, wb.id);
  assert.equal((await A.query(p.workspaces.current, {})).id, wa.id);
  const create = (
    client,
    workspace,
    definitionId,
    title,
    idempotencyKey = key(),
  ) =>
    client.mutation(p.instances.create, {
      workspaceId: workspace.id,
      definitionId,
      title,
      idempotencyKey,
    });
  const n1 = await create(A, wa, "notes", "Review notes one");
  const n2 = await create(A, wa, "notes", "Review notes two");
  const r1 = await create(A, wa, "recipes", "Review recipe");
  const bn = await create(B, wb, "notes", "Other owner notes");
  const np1 = await A.query(notes.preferences, scope(wa, n1));
  const np2 = await A.query(notes.preferences, scope(wa, n2));
  const rp = await A.query(recipes.preferences, scope(wa, r1));
  pass(scenario);

  // Every one of the 13 P2 public endpoints, with valid IDs, must deny anonymous use.
  scenario =
    "D01 all thirteen public P2 endpoints reject unauthenticated access";
  const anonymous = new ConvexHttpClient("http://127.0.0.1:3214", {
    logger: false,
  });
  const calls = [
    ["mutation", p.workspaces.ensure, {}],
    ["query", p.workspaces.current, {}],
    [
      "mutation",
      p.workspaces.setTheme,
      { workspaceId: wa.id, theme: "dark", expectedRevision: 0 },
    ],
    [
      "mutation",
      p.instances.create,
      {
        workspaceId: wa.id,
        definitionId: "notes",
        title: "Denied",
        idempotencyKey: key(),
      },
    ],
    [
      "query",
      p.instances.list,
      { workspaceId: wa.id, lifecycle: "active", cursor: null },
    ],
    ["query", p.instances.get, scope(wa, n1)],
    [
      "mutation",
      p.instances.rename,
      { ...scope(wa, n1), title: "Denied", expectedRevision: 0 },
    ],
    [
      "mutation",
      p.instances.archive,
      { ...scope(wa, n1), expectedRevision: 0 },
    ],
    [
      "query",
      p.routes.resolveInstance,
      { instanceId: n1.id, presentation: "standalone" },
    ],
    ["query", notes.preferences, scope(wa, n1)],
    [
      "mutation",
      notes.setPreferences,
      {
        ...scope(wa, n1),
        preferencesId: np1.id,
        expectedRevision: 0,
        density: "compact",
      },
    ],
    ["query", recipes.preferences, scope(wa, r1)],
    [
      "mutation",
      recipes.setPreferences,
      {
        ...scope(wa, r1),
        preferencesId: rp.id,
        expectedRevision: 0,
        density: "compact",
      },
    ],
  ];
  for (const [kind, fn, args] of calls)
    await denied(anonymous[kind](fn, args), "UNAUTHENTICATED");
  pass(scenario);

  scenario =
    "D01 all scoped public endpoints reject foreign ownership without state changes";
  for (const [kind, fn, args] of calls.slice(2))
    await denied(B[kind](fn, args));
  await denied(A.query(p.instances.get, scope(wa, bn)));
  await denied(
    A.query(p.routes.resolveInstance, {
      workspaceId: wa.id,
      instanceId: bn.id,
      presentation: "integrated",
    }),
  );
  const identityB = await B.query(p.identity.current, {});
  await frameworkRejected(
    A.mutation(p.workspaces.ensure, { ownerId: identityB.id }),
  );
  assert.equal((await A.query(p.instances.get, scope(wa, n1))).revision, 0);
  pass(scenario);

  scenario = "D02 same-definition child swaps and D03 fixed server definition";
  await denied(
    A.mutation(notes.setPreferences, {
      ...scope(wa, n1),
      preferencesId: np2.id,
      expectedRevision: 0,
      density: "compact",
    }),
  );
  await denied(
    A.mutation(notes.setPreferences, {
      ...scope(wa, r1),
      preferencesId: rp.id,
      expectedRevision: 0,
      density: "compact",
    }),
  );
  await denied(A.query(notes.preferences, scope(wa, r1)));
  await denied(A.query(recipes.preferences, scope(wa, n1)));
  await frameworkRejected(
    A.query(notes.preferences, { ...scope(wa, n1), table: "platformUsers" }),
  );
  await frameworkRejected(create(A, wa, "arbitrary", "Denied"));
  assert.equal((await A.query(notes.preferences, scope(wa, n2))).revision, 0);
  pass(scenario);

  scenario = "D04 concurrent scoped receipts and operation/owner separation";
  const retryKey = key();
  const repeated = await Promise.all(
    Array.from({ length: 8 }, () =>
      create(A, wa, "notes", "Retry result", retryKey),
    ),
  );
  assert(repeated.every((i) => i.id === repeated[0].id));
  await denied(create(A, wa, "notes", "Changed payload", retryKey), "CONFLICT");
  const otherOperation = await create(
    A,
    wa,
    "recipes",
    "Retry result",
    retryKey,
  );
  const otherOwner = await create(B, wb, "notes", "Retry result", retryKey);
  assert.equal(
    new Set([repeated[0].id, otherOperation.id, otherOwner.id]).size,
    3,
  );
  pass(scenario);

  scenario =
    "D05 actual concurrent semantic revisions and isolated preference edits";
  const edits = await Promise.allSettled(
    ["First title", "Second title"].map((title) =>
      A.mutation(p.instances.rename, {
        ...scope(wa, n1),
        title,
        expectedRevision: 0,
      }),
    ),
  );
  assert.equal(edits.filter((e) => e.status === "fulfilled").length, 1);
  const conflict = edits.find((e) => e.status === "rejected").reason;
  assert(conflict instanceof ConvexError && conflict.data.code === "CONFLICT");
  const latest = await A.query(p.instances.get, scope(wa, n1));
  assert.equal(latest.revision, 1);
  const preference = await A.mutation(notes.setPreferences, {
    ...scope(wa, n1),
    preferencesId: np1.id,
    expectedRevision: 0,
    density: "compact",
  });
  assert.equal(preference.revision, 1);
  const independent = await A.query(p.instances.get, scope(wa, n1));
  assert.equal(independent.title, latest.title);
  assert.equal(independent.revision, latest.revision);
  assert.equal(independent.preferencesVersion, 1);
  await denied(
    A.mutation(notes.setPreferences, {
      ...scope(wa, n1),
      preferencesId: np1.id,
      expectedRevision: 0,
      density: "comfortable",
    }),
    "CONFLICT",
  );
  for (const expectedRevision of [
    -1,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    await denied(
      A.mutation(p.instances.rename, {
        ...scope(wa, n1),
        title: "Invalid",
        expectedRevision,
      }),
      "VALIDATION",
    );
  pass(scenario);

  scenario = "bounded indexed pagination and foreign cursor isolation";
  const seen = new Set();
  let cursor = null;
  do {
    const page = await A.query(p.instances.list, {
      workspaceId: wa.id,
      lifecycle: "active",
      cursor,
      limit: 1,
    });
    assert(page.items.length <= 1);
    for (const item of page.items) {
      assert.equal(item.workspaceId, wa.id);
      assert(!seen.has(item.id));
      seen.add(item.id);
    }
    cursor = page.cursor;
  } while (cursor);
  assert.equal(seen.size, 5);
  const first = await A.query(p.instances.list, {
    workspaceId: wa.id,
    lifecycle: "active",
    cursor: null,
    limit: 1,
  });
  try {
    const cross = await B.query(p.instances.list, {
      workspaceId: wb.id,
      lifecycle: "active",
      cursor: first.cursor,
      limit: 1,
    });
    assert(cross.items.every((i) => i.workspaceId === wb.id));
  } catch (error) {
    assert(
      /cursor/i.test(error.message),
      "only a cursor rejection is acceptable",
    );
  }
  for (const limit of [0, -1, 101, 0.5, Infinity])
    await denied(
      A.query(p.instances.list, {
        workspaceId: wa.id,
        lifecycle: "active",
        cursor: null,
        limit,
      }),
      "VALIDATION",
    );
  await denied(
    A.query(p.instances.list, {
      workspaceId: wa.id,
      lifecycle: "active",
      cursor: "x".repeat(20000),
    }),
    "VALIDATION",
  );
  pass(scenario);

  scenario =
    "D06 archive hides every live route and receipt replay cannot resurrect";
  const retryInstance = repeated[0];
  const retryPref = await A.query(notes.preferences, scope(wa, retryInstance));
  const archived = await A.mutation(p.instances.archive, {
    ...scope(wa, retryInstance),
    expectedRevision: 0,
  });
  const again = await A.mutation(p.instances.archive, {
    ...scope(wa, retryInstance),
    expectedRevision: 0,
  });
  assert.deepEqual(again, archived);
  assert.deepEqual(
    await create(A, wa, "notes", "Retry result", retryKey),
    archived,
  );
  await denied(create(A, wa, "notes", "Changed payload", retryKey), "CONFLICT");
  await denied(A.query(p.instances.get, scope(wa, retryInstance)));
  for (const presentation of ["standalone", "integrated"])
    await denied(
      A.query(p.routes.resolveInstance, {
        instanceId: retryInstance.id,
        presentation,
      }),
    );
  await denied(A.query(notes.preferences, scope(wa, retryInstance)));
  await denied(
    A.mutation(notes.setPreferences, {
      ...scope(wa, retryInstance),
      preferencesId: retryPref.id,
      expectedRevision: 0,
      density: "compact",
    }),
  );
  await denied(
    A.mutation(p.instances.rename, {
      ...scope(wa, retryInstance),
      title: "Resurrect",
      expectedRevision: 1,
    }),
  );
  assert(
    !(
      await A.query(p.instances.list, {
        workspaceId: wa.id,
        lifecycle: "active",
        cursor: null,
      })
    ).items.some((i) => i.id === retryInstance.id),
  );
  assert(
    (
      await A.query(p.instances.list, {
        workspaceId: wa.id,
        lifecycle: "archived",
        cursor: null,
      })
    ).items.some((i) => i.id === retryInstance.id),
  );
  assert.equal(
    (
      await A.query(p.routes.resolveInstance, {
        instanceId: n1.id,
        presentation: "standalone",
      })
    ).instance.id,
    n1.id,
  );
  pass(scenario);

  scenario = "live revoked-session denial includes idempotency receipt replay";
  const session = (await A.query(p.sessions.list, { cursor: null })).page.find(
    (s) => s.current,
  );
  assert(session);
  await A.action(p.sessions.revoke, { id: session.id });
  await denied(
    create(A, wa, "notes", "Retry result", retryKey),
    "UNAUTHENTICATED",
  );
  await denied(
    A.query(p.instances.list, {
      workspaceId: wa.id,
      lifecycle: "active",
      cursor: null,
    }),
    "UNAUTHENTICATED",
  );
  assert.equal((await B.query(p.workspaces.current, {})).id, wb.id);
  pass(scenario);
  console.log(
    `Completed ${checks.length} independent actual-service P2 checks; form-text browser proof is separate; P3 files and P4 content remain pending.`,
  );
} catch (error) {
  console.error(
    `FAIL ${scenario}; details suppressed to protect fixture credentials/private values.`,
  );
  console.error(
    String(error?.stack)
      .split("\n")
      .filter((line) => line.includes("tests/platform/redteam.mjs:"))
      .join("\n"),
  );
  process.exitCode = 1;
} finally {
  for (const { client } of accounts) {
    try {
      const sessions = await client.query(p.sessions.list, { cursor: null });
      const current = sessions.page.find((s) => s.current);
      if (current) await client.action(p.sessions.revoke, { id: current.id });
    } catch {
      /* Already revoked or failed setup; never log credentials. */
    }
  }
  await browser.close();
}
