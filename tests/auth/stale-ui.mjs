// Independent A07 regressions: actual auth/backend, controlled response and
// application-continuation delays. The revoke delay is injected into the served
// module only; no production code, server operation, or identity is mocked.
import { frontendOrigin } from "./environment.mjs";
import { chromium } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const environment = readFileSync(".env.local", "utf8");
assert(
  environment.includes("CONVEX_DEPLOYMENT=anonymous:") &&
    environment.includes("http://127.0.0.1:3214") &&
    environment.includes("http://127.0.0.1:3215"),
);
assert(!Object.keys(process.env).some((key) => key.startsWith("CONVEX_")));
console.log(
  "target: local-anonymous 3214/3215; independent stale UI completion fixtures",
);
const users = Array.from({ length: 2 }, () => ({
  email: `ui-race-${randomBytes(8).toString("hex")}@example.invalid`,
  password: randomBytes(32).toString("base64url"),
  name: "Disposable UI race fixture",
}));
for (const user of users) {
  const result = spawnSync(
    "node_modules/.bin/convex",
    ["run", "provision:owner", JSON.stringify(user)],
    { stdio: "pipe", env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" } },
  );
  assert(result.status === 0, "Local fixture provisioning failed");
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function login(page, user) {
  await page.getByLabel("Email", { exact: true }).fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByTestId("private-account").waitFor({ timeout: 20000 });
}
async function identity(page) {
  const account = await page.evaluate(async () => {
    const { authClient } = await import("/src/auth/client.ts");
    const session = await authClient.getSession();
    const token = await authClient.convex.token();
    return { subject: session.data?.user.id, token: token.data?.token };
  });
  assert(
    account.subject && account.token,
    "Current account must be authenticated",
  );
  const client = new ConvexHttpClient("http://127.0.0.1:3214", {
    logger: false,
  });
  client.setAuth(account.token);
  const platform = await client.query(api.platform.identity.current, {});
  assert(platform?.id, "Current account needs positive protected access");
  return { subject: account.subject, platform: platform.id, client };
}
async function watchPrivateRegion(page) {
  await page.evaluate(() => {
    window.__palladianPrivateGone = false;
    const observer = new MutationObserver(() => {
      if (!document.querySelector('[data-testid="private-account"]'))
        window.__palladianPrivateGone = true;
    });
    observer.observe(document.querySelector('[aria-label="Authentication"]'), {
      childList: true,
      subtree: true,
    });
    window.__palladianStopWatching = () => observer.disconnect();
  });
}
async function assertStillCurrent(page, expected) {
  // Give the deliberately delayed continuation and resulting React work time
  // to execute; an immediate positive assertion could precede the regression.
  await page.waitForTimeout(750);
  assert(await page.getByTestId("private-account").isVisible());
  const current = await identity(page);
  assert(current.subject === expected.subject);
  assert(current.platform === expected.platform);
  assert(
    !(await page.evaluate(() => window.__palladianPrivateGone)),
    "Obsolete completion must not hide the current private region",
  );
  await page.evaluate(() => window.__palladianStopWatching());
}

const browser = await chromium.launch();
let releaseSignout;
let scenario = "delayed signout";
try {
  const page = await browser.newPage();
  await page.goto(frontendOrigin);
  await login(page, users[0]);
  const first = await identity(page);
  const committed = deferred();
  const hold = deferred();
  const released = deferred();
  releaseSignout = hold.resolve;
  await page.route(
    "**/api/auth/sign-out",
    async (route) => {
      const response = await route.fetch();
      assert(
        response.ok(),
        "Actual signout must succeed before response delay",
      );
      committed.resolve();
      await hold.promise;
      // Cancellation may close the obsolete request before the held response.
      await route.fulfill({ response }).catch(() => {});
      released.resolve();
    },
    { times: 1 },
  );
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await committed.promise;
  assert(
    (await first.client.query(api.platform.identity.current, {})) === null,
  );
  await page
    .getByRole("button", { name: "Retry connection", exact: true })
    .click();
  await login(page, users[1]);
  const second = await identity(page);
  assert(
    second.subject !== first.subject && second.platform !== first.platform,
  );
  await watchPrivateRegion(page);
  hold.resolve();
  await released.promise;
  await assertStillCurrent(page, second);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.close();
  console.log(
    "PASS A07 delayed real signout preserves the newer account UI and access",
  );

  scenario = "delayed current-session revoke continuation";
  const revokePage = await browser.newPage();
  let transformed = false;
  await revokePage.addInitScript(() => {
    window.__palladianRevokeCommitted = false;
    window.__palladianRevokeContinued = false;
    window.__palladianHoldRevoke = () => {
      window.__palladianRevokeCommitted = true;
      return new Promise((resolve) => {
        window.__palladianReleaseRevoke = resolve;
      });
    };
  });
  await revokePage.route("**/src/auth/Account.tsx*", async (route) => {
    const response = await route.fetch();
    assert(response.ok());
    const source = await response.text();
    const target = /void revoke\(\{\s*id: s\.id\s*\}\)\.then/g;
    assert(
      [...source.matchAll(target)].length === 1,
      "Exact revoke continuation required",
    );
    const body = source.replace(
      target,
      "void revoke({ id: s.id }).then(async (value) => { await window.__palladianHoldRevoke(); window.__palladianRevokeContinued = true; return value; }).then",
    );
    transformed = true;
    await route.fulfill({ response, body });
  });
  await revokePage.goto(frontendOrigin);
  await login(revokePage, users[0]);
  assert(transformed, "Revoke continuation delay must be installed");
  const revoked = await identity(revokePage);
  const row = revokePage
    .getByRole("region", { name: "Account", exact: true })
    .locator("div")
    .filter({ hasText: "This session" });
  await row.getByRole("button", { name: "Revoke", exact: true }).click();
  await revokePage.waitForFunction(() => window.__palladianRevokeCommitted);
  assert(
    (await revoked.client.query(api.platform.identity.current, {})) === null,
  );
  await revokePage
    .getByRole("button", { name: /^(Check session|Retry connection)$/ })
    .first()
    .click();
  await login(revokePage, users[1]);
  const replacement = await identity(revokePage);
  assert(replacement.subject !== revoked.subject);
  await watchPrivateRegion(revokePage);
  await revokePage.evaluate(() => window.__palladianReleaseRevoke());
  await revokePage.waitForFunction(() => window.__palladianRevokeContinued);
  await assertStillCurrent(revokePage, replacement);
  await revokePage
    .getByRole("button", { name: "Sign out", exact: true })
    .click();
  await revokePage.close();
  console.log(
    "PASS A07 delayed continuation after real self-revoke cannot sign out the newer account",
  );
} catch (error) {
  console.error(
    String(error?.stack)
      .split("\n")
      .filter((line) => line.includes("tests/auth/stale-ui.mjs:"))
      .join("\n"),
  );
  console.error(`FAIL ${scenario}; credentials and private data suppressed`);
  process.exitCode = 1;
} finally {
  releaseSignout?.();
  await browser.close();
}
