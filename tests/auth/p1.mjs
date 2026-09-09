import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { chromium } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
const env = readFileSync(".env.local", "utf8");
assert(
  env.includes("CONVEX_DEPLOYMENT=anonymous:") &&
    env.includes("http://127.0.0.1:3214"),
);
assert(!Object.keys(process.env).some((k) => k.startsWith("CONVEX_")));
console.log(
  "target: local-anonymous 3214/3215; disposable P1 fixture provisioning and session-age edits",
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
    { env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" }, stdio: "pipe" },
  );
  if (r.status !== 0)
    throw Error("Operator fixture command failed (output suppressed)");
}
const password = randomBytes(32).toString("base64url");
const owner = {
  email: `fixture-${randomBytes(8).toString("hex")}@example.invalid`,
  password,
  name: "Fixture owner",
};
const other = {
  ...owner,
  email: `fixture-${randomBytes(8).toString("hex")}@example.invalid`,
  name: "Fixture other",
};
admin("provision:owner", owner);
admin("provision:owner", other);
const browser = await chromium.launch();
let scenario = "boot";
const checks = [];
let debugPage;
function pass(name) {
  checks.push(name);
  console.log(`PASS ${name}`);
}
const clientPath = "/src/auth/client.ts";
async function call(page, operation) {
  return page.evaluate(
    async ({ clientPath, operation }) => {
      const { authClient: c } = await import(clientPath);
      if (operation === "session") return c.getSession();
      if (operation === "token") return c.convex.token();
      if (operation === "race")
        return Promise.all(
          Array.from({ length: 8 }, () => c.convex.token()),
        ).then((rs) => rs.every((r) => !!r.data?.token));
      if (operation === "cookie") return c.getCookie();
    },
    { clientPath, operation },
  );
}
async function ready(page) {
  await page.getByTestId("private-account").waitFor({ timeout: 20000 });
}
async function login(page, user) {
  await page.goto("http://localhost:5173");
  await page.getByLabel("Email", { exact: true }).fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await ready(page);
}
async function http(page) {
  const token = (await call(page, "token")).data?.token;
  assert(typeof token === "string", "token acquisition");
  const c = new ConvexHttpClient("http://127.0.0.1:3214", { logger: false });
  c.setAuth(token);
  return { c, token };
}
function age(id, expiresAt, createdAt = Date.now() - 400 * 86400000) {
  admin(
    "adapter:updateOne",
    {
      input: {
        model: "session",
        where: [{ field: "_id", value: id }],
        update: { expiresAt, createdAt, updatedAt: createdAt },
      },
    },
    "betterAuth",
  );
}
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  debugPage = page;
  page.on("pageerror", (error) =>
    console.log({
      browserError: true,
      closedClient: error.message.includes("closed"),
      unauthorized: error.message.includes("Unauthenticated"),
    }),
  );
  scenario = "private provisioning / public signup";
  const signup = await fetch("http://127.0.0.1:3215/api/auth/sign-up/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:5173",
    },
    body: JSON.stringify(owner),
  });
  assert(signup.status >= 400);
  pass(scenario);
  scenario = "official client sign-in, stable identity and reload";
  await login(page, owner);
  let { c, token } = await http(page);
  const original = await c.query(api.platform.identity.current, {});
  assert(original?.id);
  const ids = await Promise.all(
    Array.from({ length: 8 }, () =>
      c.mutation(api.platform.identity.ensure, {}),
    ),
  );
  assert(ids.every((id) => id === original.id));
  await page.reload();
  await ready(page);
  assert(
    (await (await http(page)).c.query(api.platform.identity.current, {}))
      ?.id === original.id,
  );
  assert(
    await page.evaluate(
      () => localStorage.getItem("palladian_session_data") === null,
    ),
  );
  pass(scenario);
  scenario = "A01 same-tab and shared-storage multitab token races";
  const tab = await context.newPage();
  await tab.goto("http://localhost:5173");
  await ready(tab);
  assert(
    (await Promise.all([call(page, "race"), call(tab, "race")])).every(Boolean),
  );
  await ready(page);
  await ready(tab);
  pass(scenario);
  scenario = "A06 initial duration, JWT, daily sliding and long inactivity";
  let session = (await call(page, "session")).data.session;
  const year = 31536000000;
  const day = 86400000;
  assert(
    Math.abs(new Date(session.expiresAt).getTime() - Date.now() - year) < 30000,
  );
  const jwt = JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString(),
  );
  assert(jwt.exp - jwt.iat === 900);
  const before = Date.now() + year - day + 30000;
  age(session.id, before);
  session = (await call(page, "session")).data.session;
  assert(
    new Date(session.expiresAt).getTime() === before,
    "before daily threshold unchanged",
  );
  age(session.id, Date.now() + year - day - 1000);
  session = (await call(page, "session")).data.session;
  assert(
    Math.abs(new Date(session.expiresAt).getTime() - Date.now() - year) < 5000,
    "daily sliding renewed",
  );
  pass(scenario);
  scenario =
    "A02 lost successful sliding renewal response and delayed token response";
  await tab.close();
  age(session.id, Date.now() + year - day - 1000);
  const cookie = await call(page, "cookie");
  let committed = false;
  await page.route("**/api/auth/get-session*", async (route) => {
    const response = await route.fetch();
    committed = response.ok();
    await route.abort("failed");
  });
  await call(page, "session").catch(() => null);
  assert(committed, "server renewal succeeded before dropping response");
  await page.unroute("**/api/auth/get-session*");
  assert((await call(page, "cookie")) === cookie, "credential survived");
  session = (await call(page, "session")).data.session;
  assert(
    Math.abs(new Date(session.expiresAt).getTime() - Date.now() - year) < 5000,
  );
  await page.route("**/api/auth/convex/token", async (route) => {
    const response = await route.fetch();
    await new Promise((r) => setTimeout(r, 4000));
    await route.fulfill({ response });
  });
  assert((await call(page, "token")).data?.token);
  await page.unroute("**/api/auth/convex/token");
  pass(scenario);
  scenario = "A04/U01 startup and renewal 429, 503, network failure";
  for (const fault of [429, 503, "network"]) {
    const credential = await call(page, "cookie");
    await page.route("**/api/auth/**", (route) =>
      fault === "network"
        ? route.abort("timedout")
        : route.fulfill({
            status: fault,
            contentType: "application/json",
            body: '{"message":"Temporary"}',
          }),
    );
    await call(page, "token").catch(() => null);
    await page.reload();
    await page
      .getByRole("heading", { name: "Everything in its place." })
      .waitFor();
    await page
      .getByRole("status")
      .filter({ hasText: "Connection unavailable. Your session is retained." })
      .waitFor();
    assert((await page.getByLabel("Email", { exact: true }).count()) === 0);
    assert((await call(page, "cookie")) === credential);
    await page.unroute("**/api/auth/**");
    await page.getByRole("button", { name: "Retry connection" }).click();
    await ready(page);
  }
  // An unresolved request must also leave shell visible, without a hard 3-second abort.
  let release;
  const blocked = new Promise((r) => {
    release = r;
  });
  await page.route("**/api/auth/get-session*", async (route) => {
    await blocked;
    await route.continue();
  });
  await page.reload();
  await page
    .getByRole("heading", { name: "Everything in its place." })
    .waitFor();
  await new Promise((r) => setTimeout(r, 3500));
  assert((await page.getByLabel("Email", { exact: true }).count()) === 0);
  release();
  await page.unrouteAll({ behavior: "wait" });
  await ready(page);
  pass(scenario);
  scenario =
    "A05 revocation with unexpired JWT and independent device survival";
  const secondContext = await browser.newContext();
  const second = await secondContext.newPage();
  await login(second, owner);
  const secondHttp = (await http(second)).c;
  ({ c, token } = await http(page));
  assert(await c.query(api.platform.identity.current, {}));
  const listed = await secondHttp.query(api.platform.sessions.list, {
    cursor: null,
  });
  assert(listed.page.some((s) => s.id === session.id));
  assert(!JSON.stringify(listed).includes("token"));
  await secondHttp.action(api.platform.sessions.revoke, { id: session.id });
  assert(
    JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).exp >
      Date.now() / 1000,
  );
  assert((await c.query(api.platform.identity.current, {})) === null);
  let denied = false;
  try {
    await c.mutation(api.platform.identity.ensure, {});
  } catch {
    denied = true;
  }
  assert(denied);
  assert(
    (await secondHttp.query(api.platform.identity.current, {}))?.id ===
      original.id,
  );
  pass(scenario);
  scenario = "A06 just-before expiry renews; just-after expiry denies";
  let secondSession = (await call(second, "session")).data.session;
  age(secondSession.id, Date.now() + 10000);
  assert((await call(second, "session")).data?.session);
  age(secondSession.id, Date.now() - 1);
  assert((await call(second, "session")).data === null);
  assert((await secondHttp.query(api.platform.identity.current, {})) === null);
  pass(scenario);
  scenario = "A07 account switch and cross-account session denial";
  await page.reload();
  await login(page, owner);
  const ownerHttp = (await http(page)).c;
  const owned = await ownerHttp.query(api.platform.sessions.list, {
    cursor: null,
  });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  assert((await page.getByTestId("private-account").count()) === 0);
  await page.getByLabel("Email", { exact: true }).waitFor();
  await login(page, other);
  const otherHttp = (await http(page)).c;
  const otherId = (await otherHttp.query(api.platform.identity.current, {}))
    ?.id;
  assert(otherId && otherId !== original.id);
  let forbidden = false;
  try {
    await otherHttp.action(api.platform.sessions.revoke, {
      id: owned.page[0].id,
    });
  } catch {
    forbidden = true;
  }
  assert(forbidden);
  assert(
    (
      await otherHttp.query(api.platform.sessions.list, { cursor: null })
    ).page.every((s) => !owned.page.some((o) => o.id === s.id)),
  );
  pass(scenario);
  scenario = "U01 separate shell/auth-data measurements, local Chromium";
  const timings = [];
  for (let i = 0; i < 6; i++) {
    await page.reload();
    await ready(page);
    timings.push(
      await page.evaluate(() => ({
        shell: performance.getEntriesByName("palladian-shell")[0]?.startTime,
        data: performance.getEntriesByName("palladian-authenticated-data")[0]
          ?.startTime,
      })),
    );
  }
  assert(timings.every((t) => t.shell >= 0 && t.data > t.shell));
  console.log(JSON.stringify({ localChromiumDevTimings: timings }));
  pass(scenario);
  scenario = "A07 cross-tab logout and failed signout remains locally cleared";
  const peer = await context.newPage();
  await peer.goto("http://localhost:5173");
  await ready(peer);
  await page.route("**/api/auth/sign-out", (route) => route.abort("timedout"));
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Server revocation was not confirmed" })
    .waitFor();
  assert((await page.getByTestId("private-account").count()) === 0);
  assert((await call(page, "cookie")) === "");
  await peer.getByLabel("Email", { exact: true }).waitFor();
  assert(
    (await otherHttp.query(api.platform.identity.current, {}))?.id === otherId,
    "Network failure must not claim server logout",
  );
  const stillLive = await otherHttp.query(api.platform.sessions.list, {
    cursor: null,
  });
  await otherHttp.action(api.platform.sessions.revoke, {
    id: stillLive.page.find((s) => s.current).id,
  });
  await peer.close();
  pass(scenario);
  await secondContext.close();
  await context.close();
  console.log(
    `Completed ${checks.length} local integration scenarios; iPhone/PWA, hosted origins, agent grants and recovery remain pending.`,
  );
} catch (error) {
  if (debugPage)
    console.log(
      await debugPage.evaluate(() => ({
        appError: document.body.textContent.includes("This app couldn’t open."),
        checking: document.body.textContent.includes("Checking session…"),
        unconfirmed: document.body.textContent.includes(
          "Server revocation was not confirmed",
        ),
        connecting: document.body.textContent.includes("Connecting account…"),
      })),
    );
  console.error(
    String(error?.stack)
      .split("\n")
      .filter((line) => line.includes("tests/auth/p1.mjs:"))
      .join("\n"),
  );
  console.error(
    `FAIL ${scenario}; details suppressed to prevent credential/private-data disclosure.`,
  );
  process.exitCode = 1;
} finally {
  await browser.close();
}
