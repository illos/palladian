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
  const page = await browser.newPage();
  await page.goto("http://localhost:5173");
  async function login(user) {
    await page.getByLabel("Email", { exact: true }).fill(user.email);
    await page.getByLabel("Password", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByTestId("private-account").waitFor({ timeout: 20000 });
  }
  async function session() {
    return page.evaluate(
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
  const delayed = session();
  await committedPromise;
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await login(users[1]);
  const second = await session();
  assert(second && second.userId !== first.userId);
  release();
  await delayed;
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
