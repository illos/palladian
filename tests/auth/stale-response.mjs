import { frontendOrigin } from "./environment.mjs";
// A07: a committed sliding response must not restore the previous account after logout/switch.
import { chromium } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
assert(
  readFileSync(".env.local", "utf8").includes("CONVEX_DEPLOYMENT=anonymous:"),
);
assert(!Object.keys(process.env).some((k) => k.startsWith("CONVEX_")));
console.log(
  "target: local-anonymous 3214/3215; fixture accounts and session-age adjustment",
);
function admin(fn, args, component) {
  const r = spawnSync(
    "node_modules/.bin/convex",
    [
      "run",
      ...(component ? ["--component", component] : []),
      fn,
      JSON.stringify(args),
    ],
    { stdio: "pipe", env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" } },
  );
  assert(r.status === 0, "Local fixture operation failed; output suppressed");
}
const users = Array.from({ length: 2 }, () => ({
  email: `stale-${randomBytes(8).toString("hex")}@example.invalid`,
  password: randomBytes(32).toString("base64url"),
  name: "Stale response fixture",
}));
users.forEach((u) => admin("provision:owner", u));
const browser = await chromium.launch();
let release;
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(frontendOrigin);
  async function login(user, target = page) {
    await target.getByLabel("Email", { exact: true }).fill(user.email);
    await target.getByLabel("Password", { exact: true }).fill(user.password);
    await target.getByRole("button", { name: "Sign in", exact: true }).click();
    await target.getByTestId("private-account").waitFor({ timeout: 20000 });
  }
  async function session(target = page) {
    return target.evaluate(
      async () =>
        (await (await import("/src/auth/client.ts")).authClient.getSession())
          .data?.session,
    );
  }
  await login(users[0]);
  const first = await session();
  admin(
    "adapter:updateOne",
    {
      input: {
        model: "session",
        where: [{ field: "_id", value: first.id }],
        update: { expiresAt: Date.now() + 31536000000 - 86400000 - 1000 },
      },
    },
    "betterAuth",
  );
  let committed;
  const committedPromise = new Promise((r) => {
    committed = r;
  });
  const held = new Promise((r) => {
    release = r;
  });
  await page.route(
    "**/api/auth/get-session*",
    async (route) => {
      const response = await route.fetch();
      assert(response.ok());
      committed();
      await held;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  // Attach immediately: native fetch can reject as soon as logout invalidates it.
  const delayed = session().then(
    () => false,
    (error) =>
      String(error?.message).includes("Authentication request superseded"),
  );
  await committedPromise;
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await login(users[1]);
  const second = await session();
  assert(second && second.userId !== first.userId);
  release();
  assert(
    await delayed,
    "Old response must be canceled without returning A data",
  );
  const result = await session();
  assert(
    result?.userId === second.userId,
    "Late renewal must not replace new account credential",
  );
  const token = await page.evaluate(
    async () =>
      (await (await import("/src/auth/client.ts")).authClient.convex.token())
        .data?.token,
  );
  assert(token);
  const c = new ConvexHttpClient("http://127.0.0.1:3214", { logger: false });
  c.setAuth(token);
  assert(await c.query(api.platform.identity.current, {}));
  console.log(
    "PASS A07 delayed old-account sliding response cannot replace the current account",
  );

  // The same race in separate same-origin tabs exercises actual browser Web
  // Locks and storage events, rather than a shared-map transport substitute.
  const expectedIdentity = await c.query(api.platform.identity.current, {});
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await login(users[0]);
  const acrossTabsA = await session();
  const other = await context.newPage();
  await other.goto(frontendOrigin);
  await other.getByTestId("private-account").waitFor({ timeout: 20000 });
  admin(
    "adapter:updateOne",
    {
      input: {
        model: "session",
        where: [{ field: "_id", value: acrossTabsA.id }],
        update: { expiresAt: Date.now() + 31536000000 - 86400000 - 1000 },
      },
    },
    "betterAuth",
  );
  const committedAcrossTabs = new Promise((resolve) => {
    committed = resolve;
  });
  const heldAcrossTabs = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(
    "**/api/auth/get-session*",
    async (route) => {
      const response = await route.fetch();
      assert(response.ok());
      committed();
      await heldAcrossTabs;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  const delayedAcrossTabs = session().then(
    () => false,
    (error) =>
      String(error?.message).includes("Authentication request superseded"),
  );
  await committedAcrossTabs;
  await other.getByRole("button", { name: "Sign out", exact: true }).click();
  await login(users[1], other);
  const acrossTabsB = await session(other);
  assert(acrossTabsB && acrossTabsB.userId !== acrossTabsA.userId);
  release();
  assert(
    await delayedAcrossTabs,
    "Other tab's account change must cancel old response",
  );
  for (const target of [page, other]) {
    await target.getByTestId("private-account").waitFor({ timeout: 20000 });
    assert.equal((await session(target))?.userId, acrossTabsB.userId);
    const token = await target.evaluate(
      async () =>
        (await (await import("/src/auth/client.ts")).authClient.convex.token())
          .data?.token,
    );
    assert(token);
    const client = new ConvexHttpClient("http://127.0.0.1:3214", {
      logger: false,
    });
    client.setAuth(token);
    assert.deepEqual(
      await client.query(api.platform.identity.current, {}),
      expectedIdentity,
    );
  }
  console.log(
    "PASS A07 separate tabs retain B UI, session and protected identity after held A response",
  );
} catch (error) {
  console.error(
    String(error?.stack)
      .split("\n")
      .filter((line) => line.includes("tests/auth/stale-response.mjs:"))
      .join("\n"),
  );
  console.error(
    "FAIL A07 delayed old-account sliding response; no credentials or private data printed",
  );
  process.exitCode = 1;
} finally {
  release?.();
  await browser.close();
}
