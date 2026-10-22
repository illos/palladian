// Real-service proof of note actions (plan 08, A2): a Convex development
// deployment + the app + Chromium on a desktop and an emulated iPhone with
// real touch input. Covers the row menu, Duplicate, Info, Move to Trash with
// Undo, drag onto a notebook, Empty Trash, swipes (full left to Trash, resting
// on Move and Share, right to Duplicate), the long-press sheet and Restore.
// Prints no secrets. Disposable @example.test accounts only.
//
// CONVEX_DEPLOYMENT selects the development deployment, NOTES_APP_URL the app
// (served with that deployment's VITE_NOTES_* URLs), NOTES_BACKEND_DIR the
// backend checkout.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(new URL("../package.json", import.meta.url));
const { chromium, devices, expect } = require("@playwright/test");
const backend =
  process.env.NOTES_BACKEND_DIR ??
  fileURLToPath(new URL("../../notes-backend", import.meta.url));
const app = process.env.NOTES_APP_URL ?? "http://localhost:5178";
const step = (message) => console.log("✓ " + message);
const shots = process.env.SCREENSHOT_DIR;
const shot = (page, name) =>
  shots ? page.screenshot({ path: `${shots}/${name}.png` }) : undefined;
if (process.env.CONVEX_PROD)
  throw new Error("Run against a development deployment.");

function setupLink(email) {
  const result = spawnSync(
    "npx",
    ["convex", "run", "provision:setupOwner", JSON.stringify({ email })],
    { cwd: backend, encoding: "utf8" },
  );
  assert.equal(result.status, 0, "setup link created");
  const out = result.stdout;
  return `${app}/invite#${JSON.parse(out.slice(out.indexOf("{"))).token}`;
}

async function connected(page) {
  await expect(page.getByTestId("session-status")).toContainText("Connected", {
    timeout: 20_000,
  });
}

/** The one-time passkey offer after a password sign-in would cover rows. */
async function dismissPasskeyOffer(page) {
  await page
    .getByRole("button", { name: "Not now" })
    .click({ timeout: 15_000 })
    .catch(() => undefined);
}

/** Calls a Convex function as the signed-in person, from inside the page. */
function convex(page, kind, path, args) {
  return page.evaluate(
    async ({ kind, path, args }) => {
      const settings = window.__palladianTest;
      const stored = JSON.parse(
        localStorage.getItem("better-auth_cookie") || "{}",
      );
      const cookie = Object.entries(stored)
        .map(([key, value]) => `${key}=${value.value}`)
        .join("; ");
      const token = (
        await (
          await fetch(settings.site + "/api/auth/convex/token", {
            headers: { "Better-Auth-Cookie": cookie },
          })
        ).json()
      ).token;
      const response = await fetch(`${settings.cloud}/api/${kind}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
        body: JSON.stringify({ path, args, format: "json" }),
      });
      const body = await response.json();
      if (body.status !== "success") throw new Error(body.errorMessage);
      return body.value;
    },
    { kind, path, args },
  );
}

/** Real touch input, so pointer and touch events fire as on a phone. */
async function fingers(page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, x, y) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x, y }],
    });
  return {
    /** Drag and hold without lifting, for a picture of the row mid-swipe. */
    async hold(x, y, dx, name) {
      await send("touchStart", x, y);
      for (let i = 1; i <= 12; i++) {
        await send("touchMove", x + (dx * i) / 12, y);
        await page.waitForTimeout(20);
      }
      await shot(page, name);
      // Back to where it started, so nothing runs.
      for (let i = 11; i >= 0; i--) {
        await send("touchMove", x + (dx * i) / 12, y);
        await page.waitForTimeout(20);
      }
      await page.waitForTimeout(120);
      await send("touchEnd", x, y);
    },
    async longPress(x, y) {
      await send("touchStart", x, y);
      await page.waitForTimeout(650);
      await send("touchEnd", x, y);
    },
    /** Move quickly, then stop and hold before lifting: not a flick. */
    async dragAndHold(x, y, dx, ms) {
      await send("touchStart", x, y);
      for (let i = 1; i <= 4; i++) {
        await send("touchMove", x + (dx * i) / 4, y);
        await page.waitForTimeout(10);
      }
      await page.waitForTimeout(ms);
      await send("touchEnd", x + dx, y);
    },
    async swipe(x, y, dx) {
      await send("touchStart", x, y);
      for (let i = 1; i <= 12; i++) {
        await send("touchMove", x + (dx * i) / 12, y);
        await page.waitForTimeout(20);
      }
      // Hold briefly so the release is a drag, not a flick.
      await page.waitForTimeout(120);
      await send("touchEnd", x + dx, y);
    },
  };
}

async function center(locator) {
  const box = await locator.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const site = process.env.CONVEX_SITE_URL;
const cloud = process.env.CONVEX_CLOUD_URL;
assert.ok(site && cloud, "CONVEX_SITE_URL and CONVEX_CLOUD_URL are set");

const browser = await chromium.launch({ headless: true });
try {
  const desk = await browser.newContext();
  await desk.addInitScript(
    ({ site, cloud }) => {
      window.__palladianTest = { site, cloud };
    },
    { site, cloud },
  );
  const page = await desk.newPage();
  const email = `actions-${randomBytes(4).toString("hex")}@example.test`;
  const password = randomBytes(18).toString("base64url");
  await page.goto(setupLink(email));
  await page.getByLabel("Your name").fill("Ada");
  await page.getByLabel(/Choose a password/).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(app + "/", { timeout: 20_000 });
  await connected(page);
  await dismissPasskeyOffer(page);
  const archive = await convex(page, "mutation", "notebooks:create", {
    name: "Archive",
  });
  const ids = {};
  for (const title of ["Alpha", "Bravo", "Charlie", "Delta", "Echo"])
    ids[title] = (
      await convex(page, "mutation", "notes:createFromMarkdown", {
        markdown: `${title}\n\nSome words about ${title.toLowerCase()}.`,
      })
    ).noteId;
  const row = (name) =>
    page.getByRole("button", { name: new RegExp(`^${name}\\b`) }).first();
  await expect(row("Echo")).toBeVisible({ timeout: 20_000 });
  step("account with five notes and a second notebook");

  await row("Alpha").click({ button: "right" });
  const menu = page.getByRole("dialog", { name: "Actions for Alpha" });
  await shot(page, "desktop-row-menu");
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Duplicate",
    "Move…",
    "Share…",
    "Info",
    "Export as Markdown",
    "Print or save as PDF",
    "Move to Trash",
  ]);
  await menu.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(page.getByText("Duplicated")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Alpha\b/ })).toHaveCount(2, {
    timeout: 20_000,
  });
  await page.locator(".toast").getByRole("button", { name: "Open" }).click();
  await expect(
    page.getByRole("textbox", { name: "Note content" }),
  ).toContainText("Some words about alpha", { timeout: 20_000 });
  step("right-click → Duplicate makes a copy, and the toast opens it");

  await page.getByRole("button", { name: "Note info" }).click();
  const info = page.getByRole("dialog", { name: "Note info" });
  await expect(info).toContainText("Created");
  await expect(info).toContainText("You");
  await expect(info.locator("dd").filter({ hasText: /^5$/ })).toHaveCount(1);
  await info.getByRole("button", { name: "Done" }).click();
  step("Info shows the dates, owner and word count");

  // The open note's actions use what its editor shows now, including typing
  // not yet saved (review F1).
  const editor = page.getByRole("textbox", { name: "Note content" });
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" Fresh words.");
  await page.getByRole("button", { name: "More actions" }).click();
  await page
    .getByRole("dialog", { name: /^Actions for/ })
    .getByRole("menuitem", { name: "Duplicate" })
    .click();
  await expect(page.getByText("Duplicated")).toBeVisible();
  const original = new URL(page.url()).pathname;
  await page.locator(".toast").getByRole("button", { name: "Open" }).click();
  // The copy is open, not the original.
  await page.waitForURL(
    (url) => url.pathname.startsWith("/notes/") && url.pathname !== original,
    { timeout: 20_000 },
  );
  await expect(editor).toContainText("Fresh words", { timeout: 20_000 });
  step("Duplicate copies the open note's current text, including new typing");

  // Trashing the open note keeps what was typed just before (review F2).
  await expect(page.locator(".toast")).toHaveCount(0, { timeout: 8_000 });
  await row("Echo").click();
  await expect(editor).toContainText("Some words about echo", {
    timeout: 20_000,
  });
  // Typing starts once the note has caught up with the server.
  await expect(editor).toHaveAttribute("contenteditable", "true", {
    timeout: 20_000,
  });
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" Last words.");
  await page.getByRole("button", { name: "Move note to Trash" }).click();
  await expect(page.getByText("Moved to Trash")).toBeVisible();
  await expect(editor).toBeHidden();
  await page.locator(".toast").getByRole("button", { name: "Undo" }).click();
  await expect(
    page.locator(".note-row", { hasText: "Echo" }).first(),
  ).not.toContainText("In Trash", { timeout: 20_000 });
  await row("Echo").click();
  await expect(editor).toContainText("Last words", { timeout: 20_000 });
  step("trashing the open note keeps its latest typing; Undo, and it is there");

  // A menu closes when the note's actions change under it (review F4).
  await row("Delta").click({ button: "right" });
  const deltaMenu = page.getByRole("dialog", { name: "Actions for Delta" });
  await expect(deltaMenu).toBeVisible();
  await convex(page, "mutation", "notes:trash", { noteId: ids.Delta });
  await expect(deltaMenu).toBeHidden({ timeout: 20_000 });
  await convex(page, "mutation", "notes:restore", { noteId: ids.Delta });
  await expect(
    page.locator(".note-row", { hasText: "Delta" }).first(),
  ).not.toContainText("In Trash", { timeout: 20_000 });
  step("an open menu closes when the note moves to Trash elsewhere");

  await row("Bravo").hover();
  await page
    .locator(".note-row-wrap", { has: row("Bravo") })
    .locator(".row-more")
    .click();
  await page
    .getByRole("dialog", { name: "Actions for Bravo" })
    .getByRole("menuitem", { name: "Move to Trash" })
    .click();
  await expect(page.getByText("Moved to Trash")).toBeVisible();
  await expect(
    page.locator(".note-row", { hasText: "Bravo" }).first(),
  ).toContainText("In Trash", { timeout: 20_000 });
  await page.locator(".toast").getByRole("button", { name: "Undo" }).click();
  await expect(
    page.locator(".note-row", { hasText: "Bravo" }).first(),
  ).not.toContainText("In Trash", { timeout: 20_000 });
  step("Move to Trash from the row's … menu, then Undo restores it");

  await row("Charlie").dragTo(
    page.locator(".navigation").getByRole("button", { name: "Archive" }),
  );
  const move = page.getByRole("dialog", { name: "Move note" });
  await expect(move.getByRole("combobox")).toHaveValue(archive, {
    timeout: 10_000,
  });
  await move.getByRole("button", { name: "Move" }).click();
  await page
    .locator(".navigation")
    .getByRole("button", { name: "Archive" })
    .click();
  await expect(row("Charlie")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: /^Alpha\b/ })).toHaveCount(0);
  step("dragging a note onto a notebook opens Move with it chosen");

  await page
    .locator(".navigation")
    .getByRole("button", { name: "All Notes" })
    .click();
  await row("Delta").click({ button: "right" });
  await page
    .getByRole("dialog", { name: "Actions for Delta" })
    .getByRole("menuitem", { name: "Move to Trash" })
    .click();
  await page
    .locator(".navigation")
    .getByRole("button", { name: "Trash" })
    .click();
  await expect(page.getByText(/deleted forever after 30 days/)).toBeVisible();
  await shot(page, "desktop-trash");
  await expect(row("Delta")).toBeVisible({ timeout: 20_000 });
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Empty Trash" }).click();
  await expect(page.getByText("Deleted 1 note forever")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("Trash is empty.")).toBeVisible({
    timeout: 20_000,
  });
  step("the Trash view states the retention policy and Empty Trash deletes");

  // The same account on a phone.
  const phoneContext = await browser.newContext({
    ...devices["iPhone 15 Plus"],
  });
  const phone = await phoneContext.newPage();
  await phone.goto(app + "/");
  await phone.getByLabel("Email", { exact: true }).fill(email);
  await phone.getByLabel("Password", { exact: true }).fill(password);
  await phone.getByRole("button", { name: "Sign in", exact: true }).click();
  await connected(phone);
  await dismissPasskeyOffer(phone);
  const touch = await fingers(phone);
  const phoneRow = (name) =>
    phone.getByRole("button", { name: new RegExp(`^${name}\\b`) }).first();
  await expect(phoneRow("Echo")).toBeVisible({ timeout: 20_000 });

  let at = await center(phoneRow("Echo"));
  if (shots) await touch.hold(at.x, at.y, -230, "phone-full-swipe");
  await touch.swipe(at.x, at.y, -260);
  await expect(phone.getByText("Moved to Trash")).toBeVisible({
    timeout: 10_000,
  });
  await phone.locator(".toast").getByRole("button", { name: "Undo" }).click();
  await expect(
    phone.locator(".note-row", { hasText: "Echo" }).first(),
  ).not.toContainText("In Trash", { timeout: 20_000 });
  step("phone: a full left swipe moves to Trash; Undo restores");

  at = await center(phoneRow("Echo"));
  await touch.swipe(at.x, at.y, -120);
  const share = phone.locator(".swipe-actions.trailing").getByRole("button", {
    name: "Share",
  });
  await expect(share).toBeVisible();
  await shot(phone, "phone-swipe-left-rest");
  await expect(
    phone
      .locator(".swipe-actions.trailing")
      .getByRole("button", { name: "Move" }),
  ).toBeVisible();
  await share.click();
  await expect(phone.getByRole("dialog", { name: /Share/ })).toBeVisible();
  await phone.getByRole("button", { name: "Done" }).click();
  step("phone: a short left swipe rests on Move and Share");

  at = await center(phoneRow("Echo"));
  await touch.swipe(at.x, at.y, 120);
  await phone
    .locator(".swipe-actions.leading")
    .getByRole("button", { name: "Duplicate" })
    .click();
  await expect(phone.getByText("Duplicated")).toBeVisible();
  await expect(phone.getByRole("button", { name: /^Echo\b/ })).toHaveCount(2, {
    timeout: 20_000,
  });
  step("phone: a right swipe rests on Duplicate");

  // Toasts sit over the bottom of the list until they time out.
  await expect(phone.locator(".toast")).toHaveCount(0, { timeout: 8_000 });
  // Clear of the bottom bar, which a press there would hit instead.
  await phoneRow("Bravo").evaluate((row) =>
    row.scrollIntoView({ block: "center" }),
  );
  at = await center(phoneRow("Bravo"));
  await touch.longPress(at.x, at.y);
  if (
    !(await phone
      .getByRole("dialog", { name: "Actions for Bravo" })
      .isVisible())
  )
    await phone.screenshot({ path: "/tmp/actions-longpress.png" });
  const sheet = phone.getByRole("dialog", { name: "Actions for Bravo" });
  await expect(sheet).toBeVisible();
  await shot(phone, "phone-action-sheet");
  await sheet.getByRole("menuitem", { name: "Move to Trash" }).click();
  await phone.getByRole("button", { name: "Open navigation" }).first().click();
  await phone.getByRole("button", { name: "Trash" }).click();
  at = await center(phoneRow("Bravo"));
  await touch.swipe(at.x, at.y, 120);
  await phone
    .locator(".swipe-actions.leading")
    .getByRole("button", { name: "Restore" })
    .click();
  await expect(phone.getByText("Restored")).toBeVisible();
  await expect(phone.getByText("Trash is empty.")).toBeVisible({
    timeout: 20_000,
  });
  step("phone: long press → Move to Trash; in Trash a right swipe restores");

  await phone.getByRole("button", { name: "Open navigation" }).first().click();
  await phone.getByRole("button", { name: "All Notes" }).click();
  at = await center(phoneRow("Charlie"));
  await touch.dragAndHold(at.x, at.y, -40, 1000);
  await expect(phone.locator(".swipe-actions")).toHaveCount(0);
  step("phone: a short drag held still before release does not open the row");

  // The row resting open follows its actions when they change (review F6).
  at = await center(phoneRow("Charlie"));
  await touch.swipe(at.x, at.y, -120);
  const trailing = phone.locator(".swipe-actions.trailing");
  await expect(trailing.getByRole("button", { name: "Move" })).toBeVisible();
  await convex(page, "mutation", "notes:trash", { noteId: ids.Charlie });
  await expect(trailing.getByRole("button", { name: "Move" })).toHaveCount(0, {
    timeout: 20_000,
  });
  await expect(trailing.getByRole("button")).toHaveText(["Delete"]);
  await convex(page, "mutation", "notes:restore", { noteId: ids.Charlie });
  step("phone: an open row shows the new actions when the note moves to Trash");
} catch (failure) {
  // A picture of each page at the failure, for the person debugging it.
  for (const [i, open] of browser
    .contexts()
    .flatMap((c) => c.pages())
    .entries())
    await open.screenshot({ path: `/tmp/actions-e2e-failure-${i}.png` });
  throw failure;
} finally {
  await browser.close();
}
