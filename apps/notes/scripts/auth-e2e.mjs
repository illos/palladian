// Real-service proof of signing in: a Convex deployment + the app + Chromium
// with a virtual passkey authenticator. Covers the signed-out screen, owner
// setup, the passkey offer, passkey sign-in, forgot password, reset with the
// agent choice, and other devices being signed out. Prints no secrets.
//
// The reset link is read from the deployment's own verification table (not
// an inbox), so run this against a development deployment: CONVEX_DEPLOYMENT
// selects it, NOTES_APP_URL is the app, NOTES_BACKEND_DIR the backend.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(new URL("../package.json", import.meta.url));
const { chromium, devices, expect } = require("@playwright/test");
const backend =
  process.env.NOTES_BACKEND_DIR ??
  fileURLToPath(new URL("../../notes-backend", import.meta.url));
const app = process.env.NOTES_APP_URL ?? "http://localhost:5178";
const shots = process.env.SCREENSHOT_DIR;
const step = (message) => console.log("✓ " + message);
if (process.env.CONVEX_PROD)
  throw new Error("Run against a development deployment.");
if (shots) mkdirSync(shots, { recursive: true });

function convex(args) {
  const result = spawnSync("npx", ["convex", ...args], {
    cwd: backend,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `convex ${args[0]} succeeded`);
  return result.stdout;
}

function setupLink(email) {
  const out = convex([
    "run",
    "provision:setupOwner",
    JSON.stringify({ email }),
  ]);
  return `${app}/invite#${JSON.parse(out.slice(out.indexOf("{"))).token}`;
}

/** The newest reset token in the deployment, kept in memory only. */
function latestResetToken(after) {
  const out = convex([
    "data",
    "--component",
    "betterAuth",
    "verification",
    "--limit",
    "20",
    "--format",
    "jsonLines",
  ]);
  const rows = out
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line))
    .filter(
      (row) =>
        row.identifier.startsWith("reset-password:") &&
        row._creationTime > after,
    )
    .sort((a, b) => b._creationTime - a._creationTime);
  assert.ok(rows[0], "a reset token was issued");
  return rows[0].identifier.slice("reset-password:".length);
}

async function shot(page, name) {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
}

async function connected(page) {
  await expect(page.getByTestId("session-status")).toContainText("Connected", {
    timeout: 20_000,
  });
}

async function addAuthenticator(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  );
  return async () =>
    (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials
      .length;
}

/** Notes, note text and drafts this device holds for any account. */
function cachedCopies(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("palladian-notes-foundation");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const names = ["summaries", "bodies", "drafts"];
          const tx = db.transaction(names, "readonly");
          let total = 0;
          let pending = names.length;
          for (const name of names) {
            const count = tx.objectStore(name).count();
            count.onsuccess = () => {
              total += count.result;
              if (--pending === 0) {
                db.close();
                resolve(total);
              }
            };
          }
        };
      }),
  );
}

/** Settings → Account → Sign out, confirmed (a wide window). */
async function signOut(page) {
  await page.locator(".connection-status").click();
  await page.getByRole("button", { name: "Sign out…" }).click();
  await page.getByRole("button", { name: "Sign out of this device" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible({
    timeout: 20_000,
  });
}

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const credentials = await addAuthenticator(context, page);

  await page.goto(app + "/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText(/invite-only/)).toBeVisible();
  await shot(page, "signed-out");
  step("a new device sees a full sign-in screen, not an empty library");

  await page.getByRole("button", { name: "Forgot password?" }).click();
  await page
    .getByLabel("Email")
    .fill(`nobody-${randomBytes(3).toString("hex")}@example.test`);
  await page.getByRole("button", { name: "Email me a reset link" }).click();
  await expect(page.getByText(/a reset link is on its way/)).toBeVisible();
  step("forgot password answers the same whether or not an account exists");

  const email = `owner-${randomBytes(4).toString("hex")}@example.test`;
  const password = randomBytes(18).toString("base64url");
  await page.goto(setupLink(email));
  await page.getByLabel("Your name").fill("Ada");
  await page.getByLabel(/Choose a password/).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(app + "/", { timeout: 20_000 });
  await connected(page);
  step("owner account created from a setup link and signed in");

  const offer = page.getByRole("heading", { name: /next time\?/ });
  await expect(offer).toBeVisible({ timeout: 20_000 });
  await shot(page, "passkey-offer");
  await page.getByRole("button", { name: "Set up passkey" }).click();
  await expect(page.getByText(/Passkey added/)).toBeVisible({
    timeout: 20_000,
  });
  assert.equal(await credentials(), 1, "one passkey on the authenticator");
  step("after account setup the device offers a passkey and registers one");

  await signOut(page);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await connected(page);
  await expect(offer).toBeHidden();
  step("signed out, then signed back in with the passkey");

  await page.getByRole("button", { name: "Settings" }).first().click();
  await expect(page.getByText("New notes from All Notes go to")).toBeVisible({
    timeout: 20_000,
  });
  await shot(page, "account-settings");
  await page.getByRole("button", { name: "Security & devices" }).click();
  await expect(
    page.getByRole("heading", { name: "Sign-in & security" }),
  ).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    page.getByText(/^(Mac|Windows|This device|Android|iPhone|iPad) · added/),
  ).toBeVisible();
  // The virtual authenticator can complete the autofill request as well as
  // the button's, so a passkey sign-in may leave two sessions here.
  await expect(
    page.locator(".devices-section li").filter({ hasText: "This device" }),
  ).toHaveCount(1);
  await shot(page, "security-settings");
  await page.locator(".settings-back").click();
  step("settings list the passkey and this device");

  await page
    .getByRole("button", { name: "New note", exact: true })
    .first()
    .click();
  const editor = page.getByRole("textbox", { name: "Note content" });
  await expect(editor).toHaveAttribute("contenteditable", "true", {
    timeout: 10_000,
  });
  await editor.click();
  await page.keyboard.type("Private note\nOnly for my devices");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // A second device, signed in with the password, caching the note.
  const other = await browser.newContext();
  const phone = await other.newPage();
  await phone.goto(app + "/");
  await phone.getByLabel("Email", { exact: true }).fill(email);
  await phone.getByLabel("Password", { exact: true }).fill(password);
  await phone.getByRole("button", { name: "Sign in", exact: true }).click();
  await connected(phone);
  await phone.getByRole("button", { name: /Private note/ }).click();
  await expect(
    phone.getByRole("textbox", { name: "Note content" }),
  ).toContainText("Only for my devices", { timeout: 15_000 });
  assert.ok((await cachedCopies(phone)) > 0, "the second device holds copies");
  step("a second device signs in with the password and caches the note");

  await signOut(page);
  const before = Date.now() - 5_000;
  await page.getByRole("button", { name: "Forgot password?" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a reset link" }).click();
  await expect(page.getByText(/a reset link is on its way/)).toBeVisible();
  const token = latestResetToken(before);
  step("a reset link was issued for the account");

  const fresh = randomBytes(18).toString("base64url");
  await page.goto(`${app}/reset#${token}`);
  await page.getByLabel(/^New password/).fill(fresh);
  await page.getByLabel("Confirm new password").fill(fresh);
  await page.getByRole("button", { name: "Set new password" }).click();
  // Nothing is preselected; the form will not submit without a choice.
  assert.equal(
    await page
      .getByLabel(/Keep them connected/)
      .evaluate((el) => el.validity.valueMissing),
    true,
  );
  await expect(page).toHaveURL(/\/reset#/);
  await page.getByLabel(/Disconnect them/).check();
  await shot(page, "reset");
  await page.getByRole("button", { name: "Set new password" }).click();
  await page.waitForURL(app + "/", { timeout: 20_000 });
  await connected(page);
  step(
    "the reset requires an explicit agent choice, then signs in with the new password",
  );

  await phone.reload();
  await expect(
    phone.getByRole("heading", { name: "Sign in to sync" }),
  ).toBeVisible({
    timeout: 30_000,
  });
  // This release signs other devices out without removing their copies (the
  // wipe of D98 follows separately).
  assert.ok(
    (await cachedCopies(phone)) > 0,
    "the second device keeps its copies",
  );
  await shot(phone, "reconnect");
  step("the other device was signed out and keeps its cached notes readable");

  await page.goto(`${app}/reset#${token}`);
  await page.getByLabel(/^New password/).fill(password);
  await page.getByLabel("Confirm new password").fill(password);
  await page.getByLabel(/Keep them connected/).check();
  await page.getByRole("button", { name: "Set new password" }).click();
  await expect(page.getByText(/expired or was already used/)).toBeVisible();
  step("a used reset link is refused");

  // Signing another device out from Settings.
  await page.goto(app + "/");
  await connected(page);
  const laptopContext = await browser.newContext();
  const laptop = await laptopContext.newPage();
  await laptop.goto(app + "/");
  await laptop.getByLabel("Email", { exact: true }).fill(email);
  await laptop.getByLabel("Password", { exact: true }).fill(fresh);
  await laptop.getByRole("button", { name: "Sign in", exact: true }).click();
  await connected(laptop);
  await laptop.getByRole("button", { name: /Private note/ }).click();
  await expect(
    laptop.getByRole("textbox", { name: "Note content" }),
  ).toContainText("Only for my devices", { timeout: 15_000 });
  // The laptop watches its own device list while it is signed out.
  await laptop.getByRole("button", { name: "Settings" }).first().click();
  await laptop.getByRole("button", { name: "Security & devices" }).click();
  await expect(laptop.locator(".devices-section li")).toHaveCount(2, {
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByRole("button", { name: "Security & devices" }).click();
  const rows = page.locator(".devices-section li");
  // The reset ended every session: this page and the laptop remain.
  await expect(rows).toHaveCount(2, { timeout: 20_000 });
  await page.getByRole("button", { name: /^Sign out .+ · / }).click();
  await page
    .locator(".devices-section")
    .getByRole("button", { name: "Sign out", exact: true })
    .click();
  await expect(rows).toHaveCount(1, { timeout: 20_000 });
  await expect(rows).toContainText("This device");
  // Without a reload, the laptop asks to sign in again instead of going blank,
  // and its cached notes stay readable.
  await expect(
    laptop.getByRole("heading", { name: "Sign in to sync" }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    laptop.getByRole("heading", { name: "Security & devices" }),
  ).toBeVisible();
  await laptop.locator(".settings-back").click();
  await expect(
    laptop.getByRole("button", { name: /Private note/ }),
  ).toBeVisible();
  await laptop.reload();
  await expect(
    laptop.getByRole("heading", { name: "Sign in to sync" }),
  ).toBeVisible({ timeout: 30_000 });
  assert.ok(
    (await cachedCopies(laptop)) > 0,
    "the signed-out device keeps its copies",
  );
  await page.locator(".settings-back").click();
  await connected(page);
  step(
    "signing a device out from Settings ends its session at once; it asks to sign in and keeps its copies",
  );

  const mobile = await browser.newContext({ ...devices["iPhone 15 Plus"] });
  const small = await mobile.newPage();
  await small.goto(app + "/");
  await expect(small.getByRole("heading", { name: "Sign in" })).toBeVisible({
    timeout: 20_000,
  });
  await shot(small, "signed-out-phone");
  step("the sign-in screen fits a phone");
} finally {
  await browser.close();
}
