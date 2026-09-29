import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const uiRoot =
  process.env.NOTES_UI_ROOT ??
  fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(`${uiRoot}/apps/notes/package.json`);
const { chromium, expect } = require("@playwright/test");
const cli = fileURLToPath(
  new URL("./node_modules/.bin/convex", import.meta.url),
);
const email = `browser-proof-${randomBytes(8).toString("hex")}@example.invalid`;
const password = randomBytes(24).toString("hex");
const fixture = spawnSync(
  cli,
  ["run", "auth:fixture", JSON.stringify({ email, password })],
  { encoding: "utf8", cwd: fileURLToPath(new URL(".", import.meta.url)) },
);
assert.equal(fixture.status, 0, "disposable browser subject provisioned");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto("http://localhost:5178/");
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByTestId("session-status")).toContainText(
    "Session connected",
    { timeout: 15_000 },
  );
  const hint = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("palladian.notes.account-hint.v1")),
  );
  assert.ok(
    hint.accountId && !hint.signedOut,
    "real browser account hint persisted",
  );
  await page
    .getByRole("button", { name: "New note", exact: true })
    .first()
    .click();
  const editor = page.getByRole("textbox", { name: "Note content" });
  await editor.fill(
    "Browser auth cache proof\nThis draft stays visible during auth failure.",
  );
  await expect(
    page.getByText("Draft saved on this device — not saved to server"),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("session-status")).toContainText(
    "Session connected",
    { timeout: 15_000 },
  );
  await expect(
    page.getByRole("button", { name: /Browser auth cache proof/ }),
  ).toBeVisible();
  const afterReload = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("palladian.notes.account-hint.v1")),
  );
  assert.equal(
    afterReload.accountId,
    hint.accountId,
    "real browser reload retains account",
  );
  await page.route("http://127.0.0.1:3219/**", (route) =>
    route.fulfill({
      status: 503,
      headers: {
        "access-control-allow-origin": "http://localhost:5178",
        "access-control-allow-credentials": "true",
      },
      contentType: "application/json",
      body: JSON.stringify({ message: "Disposable network failure" }),
    }),
  );
  await page
    .getByRole("button", { name: "Retry connection", exact: true })
    .click();
  await expect(page.getByTestId("session-status")).toContainText(
    "Reconnecting — cached notes remain available",
    { timeout: 15_000 },
  );
  await page.getByRole("button", { name: /Browser auth cache proof/ }).click();
  await expect(editor).toContainText(
    "This draft stays visible during auth failure.",
  );
  const afterFailure = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("palladian.notes.account-hint.v1")),
  );
  assert.equal(
    afterFailure.accountId,
    hint.accountId,
    "503 does not delete account state",
  );
  await page.unroute("http://127.0.0.1:3219/**");
  await page
    .getByRole("button", { name: "Retry connection", exact: true })
    .click();
  await expect(page.getByTestId("session-status")).toContainText(
    "Session connected",
    { timeout: 15_000 },
  );
  const pendingRequests = [];
  await page.route("http://127.0.0.1:3219/**", (route) => {
    pendingRequests.push(route);
  });
  const launchStart = performance.now();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("button", { name: /Browser auth cache proof/ }),
  ).toBeVisible();
  const visibleMs = Math.round(performance.now() - launchStart);
  await page.getByRole("button", { name: /Browser auth cache proof/ }).click();
  await expect(editor).toContainText(
    "This draft stays visible during auth failure.",
  );
  await expect(page.getByTestId("session-status")).toContainText(
    "Connecting — cached notes remain available",
  );
  await expect.poll(() => pendingRequests.length).toBeGreaterThan(0);
  console.log(
    `OBSERVED: Chromium development reload-to-cached-title ${visibleMs}ms with actual authentication requests held pending; not an iPhone or production performance budget.`,
  );
  console.log(
    "PASS: actual browser password form, persisted account/session across reload, durable local draft, 503 preserves cached content and account, retry reconnects without sign-in.",
  );
} finally {
  await browser.close();
}
