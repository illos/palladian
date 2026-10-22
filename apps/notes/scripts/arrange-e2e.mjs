// Real-service proof of pins and sort orders (plan 08, A6; D102): a Convex
// development deployment + the app + Chromium on a desktop and an emulated
// iPhone with real touch input. Covers sort orders kept across reloads and
// devices, pinning from the menu and by a full right swipe, and custom order
// by mouse drag, keyboard and touch drag. Disposable @example.test accounts;
// prints no secrets.
//
// CONVEX_DEPLOYMENT selects the development deployment, CONVEX_SITE_URL and
// CONVEX_CLOUD_URL its URLs, NOTES_APP_URL the app (served with those URLs),
// NOTES_BACKEND_DIR the backend checkout.
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
const site = process.env.CONVEX_SITE_URL;
const cloud = process.env.CONVEX_CLOUD_URL;
const step = (message) => console.log("✓ " + message);
if (process.env.CONVEX_PROD)
  throw new Error("Run against a development deployment.");
assert.ok(site && cloud, "CONVEX_SITE_URL and CONVEX_CLOUD_URL are set");

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

async function dismissPasskeyOffer(page) {
  await page
    .getByRole("button", { name: "Not now" })
    .click({ timeout: 15_000 })
    .catch(() => undefined);
}

/** Calls a Convex function as the signed-in person, from inside the page. */
function convex(page, kind, path, args) {
  return page.evaluate(
    async ({ kind, path, args, site, cloud }) => {
      const stored = JSON.parse(
        localStorage.getItem("better-auth_cookie") || "{}",
      );
      const cookie = Object.entries(stored)
        .map(([key, value]) => `${key}=${value.value}`)
        .join("; ");
      const token = (
        await (
          await fetch(site + "/api/auth/convex/token", {
            headers: { "Better-Auth-Cookie": cookie },
          })
        ).json()
      ).token;
      const response = await fetch(`${cloud}/api/${kind}`, {
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
    { kind, path, args, site, cloud },
  );
}

async function fingers(page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, x, y) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x, y }],
    });
  return {
    async drag(x, y, dx, dy) {
      await send("touchStart", x, y);
      for (let i = 1; i <= 15; i++) {
        await send("touchMove", x + (dx * i) / 15, y + (dy * i) / 15);
        await page.waitForTimeout(20);
      }
      await page.waitForTimeout(120);
      await send("touchEnd", x + dx, y + dy);
    },
  };
}

async function center(locator) {
  const box = await locator.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const titles = (page) =>
  page
    .locator(".note-row strong")
    .allInnerTexts()
    .then((all) => all.map((t) => t.trim()));

async function expectOrder(page, expected) {
  await expect.poll(() => titles(page), { timeout: 20_000 }).toEqual(expected);
}

/** Live sync is running once the sort control is enabled. */
async function live(page) {
  await expect(page.getByRole("combobox", { name: "Sort notes" })).toBeEnabled({
    timeout: 20_000,
  });
}

/** Waits until the server's arrangement passes `check`, before a reload. */
async function saved(page, check) {
  await expect
    .poll(
      async () => check(await convex(page, "query", "arrangement:mine", {})),
      { timeout: 20_000 },
    )
    .toBe(true);
}

const browser = await chromium.launch({ headless: true });
try {
  const desk = await browser.newContext();
  const page = await desk.newPage();
  const email = `arrange-${randomBytes(4).toString("hex")}@example.test`;
  const password = randomBytes(18).toString("base64url");
  await page.goto(setupLink(email));
  await page.getByLabel("Your name").fill("Ada");
  await page.getByLabel(/Choose a password/).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(app + "/", { timeout: 20_000 });
  await connected(page);
  await dismissPasskeyOffer(page);
  const ids = {};
  for (const title of ["Delta", "Alpha", "Charlie", "Bravo"])
    ids[title] = (
      await convex(page, "mutation", "notes:createFromMarkdown", {
        markdown: `${title}\n\nAbout ${title.toLowerCase()}.`,
      })
    ).noteId;
  await expectOrder(page, ["Bravo", "Charlie", "Alpha", "Delta"]);
  step("four notes, newest edited first by default");

  const sort = page.getByRole("combobox", { name: "Sort notes" });
  await live(page);
  await sort.selectOption("alpha");
  await expectOrder(page, ["Alpha", "Bravo", "Charlie", "Delta"]);
  await saved(page, (a) =>
    a.orders.some((o) => o.list === "all" && o.order === "alpha"),
  );
  await page.reload();
  await connected(page);
  await live(page);
  await expectOrder(page, ["Alpha", "Bravo", "Charlie", "Delta"]);
  await expect(sort).toHaveValue("alpha");
  step("All Notes sorted alphabetically, kept after a reload");

  const row = (name) =>
    page.getByRole("button", { name: new RegExp(`^${name}\\b`) }).first();
  await row("Charlie").click({ button: "right" });
  await page
    .getByRole("dialog", { name: "Actions for Charlie" })
    .getByRole("menuitem", { name: "Pin" })
    .click();
  await expect(page.getByText("Pinned", { exact: true })).toBeVisible();
  await expectOrder(page, ["Charlie", "Alpha", "Bravo", "Delta"]);
  await expect(
    page.locator(".note-row-wrap").first().locator(".row-pin"),
  ).toHaveCount(1);
  step("pinning from the menu puts the note on top with a pin");

  // The same arrangement on a phone; a full right swipe pins another note.
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
  await live(phone);
  await expectOrder(phone, ["Charlie", "Alpha", "Bravo", "Delta"]);
  const touch = await fingers(phone);
  const deltaRow = phone.getByRole("button", { name: /^Delta\b/ }).first();
  const at = await center(deltaRow);
  await touch.drag(at.x - 100, at.y, 260, 0);
  await expect(phone.getByText("Pinned", { exact: true })).toBeVisible();
  await expectOrder(phone, ["Delta", "Charlie", "Alpha", "Bravo"]);
  await expectOrder(page, ["Delta", "Charlie", "Alpha", "Bravo"]);
  step(
    "the phone shows the same order; a full right swipe pins, newest pin on top",
  );

  await row("Delta").click({ button: "right" });
  await page
    .getByRole("dialog", { name: "Actions for Delta" })
    .getByRole("menuitem", { name: "Unpin" })
    .click();
  await expectOrder(page, ["Charlie", "Alpha", "Bravo", "Delta"]);
  step("Unpin returns the note to its place");

  // Custom order in the notebook.
  await page
    .locator(".navigation")
    .getByRole("button", { name: "Notes", exact: true })
    .click();
  await expect(sort).toHaveValue("edited");
  await sort.selectOption("custom");
  await expectOrder(page, ["Charlie", "Bravo", "Alpha", "Delta"]);
  const handle = (name) =>
    page.getByRole("button", { name: `Reorder ${name}` });
  await handle("Alpha").hover();
  await page.mouse.down();
  const target = await page
    .getByRole("button", { name: /^Bravo\b/ })
    .first()
    .boundingBox();
  await page.mouse.move(target.x + 20, target.y + 4, { steps: 12 });
  await page.mouse.up();
  await expectOrder(page, ["Charlie", "Alpha", "Bravo", "Delta"]);
  step("custom order: dragging a note by its handle puts it in place");

  await handle("Delta").focus();
  await page.keyboard.press("ArrowUp");
  await expectOrder(page, ["Charlie", "Alpha", "Delta", "Bravo"]);
  await saved(page, (a) => {
    const key = (title) =>
      a.positions.find((p) => p.noteId === ids[title])?.key;
    return key("Alpha") < key("Delta") && key("Delta") < key("Bravo");
  });
  await page.reload();
  await connected(page);
  await live(page);
  // A reload opens All Notes.
  await page
    .locator(".navigation")
    .getByRole("button", { name: "Notes", exact: true })
    .click();
  await expectOrder(page, ["Charlie", "Alpha", "Delta", "Bravo"]);
  step("the arrow keys move a note; the custom order is kept after a reload");

  await phone.getByRole("button", { name: "Open navigation" }).first().click();
  await phone.getByRole("button", { name: "Notes", exact: true }).click();
  await expectOrder(phone, ["Charlie", "Alpha", "Delta", "Bravo"]);
  const grip = await center(
    phone.getByRole("button", { name: "Reorder Bravo" }),
  );
  const top = await center(
    phone.getByRole("button", { name: /^Charlie\b/ }).first(),
  );
  // Pinned Charlie stays on top; dropping above Alpha puts Bravo second.
  await touch.drag(grip.x, grip.y, 0, top.y - grip.y + 10);
  await expectOrder(phone, ["Charlie", "Bravo", "Alpha", "Delta"]);
  await expectOrder(page, ["Charlie", "Bravo", "Alpha", "Delta"]);
  step("on the phone, a touch drag on the handle reorders, seen on both");

  // A notebook longer than the first rendered rows still reorders (review F8).
  const big = await convex(page, "mutation", "notebooks:create", {
    name: "Big",
  });
  for (let i = 1; i <= 62; i++)
    await convex(page, "mutation", "notes:createFromMarkdown", {
      notebookId: big,
      markdown: `Item ${String(i).padStart(2, "0")}\n\nNumber ${i}.`,
    });
  await page
    .locator(".navigation")
    .getByRole("button", { name: "Big", exact: true })
    .click();
  await sort.selectOption("custom");
  // Newest first: Item 62, Item 61, …
  await expect
    .poll(async () => (await titles(page)).slice(0, 3), { timeout: 20_000 })
    .toEqual(["Item 62", "Item 61", "Item 60"]);
  await handle("Item 62").hover();
  await page.mouse.down();
  const third = await page
    .getByRole("button", { name: /^Item 60\b/ })
    .first()
    .boundingBox();
  await page.mouse.move(third.x + 20, third.y + third.height - 4, {
    steps: 12,
  });
  await page.mouse.up();
  await expect
    .poll(async () => (await titles(page)).slice(0, 3), { timeout: 20_000 })
    .toEqual(["Item 61", "Item 60", "Item 62"]);
  step("a notebook of 62 notes reorders by dragging, beyond the rendered rows");
} catch (failure) {
  // A picture of each page at the failure, for the person debugging it.
  for (const [i, open] of browser
    .contexts()
    .flatMap((c) => c.pages())
    .entries())
    await open.screenshot({ path: `/tmp/arrange-e2e-failure-${i}.png` });
  throw failure;
} finally {
  await browser.close();
}
