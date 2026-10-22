// Real-service proof of notebook management (plan 08, A5): a Convex
// development deployment + the app + Chromium on a desktop and an emulated
// iPhone with real touch input. Covers the notebook menu (right-click, hover
// "…", the list header and a phone long press), name and description, set as
// default, new note here, deleting with the notes moved (a member losing
// access, with the warning first) and deleting to Trash, the default
// notebook asking for another default first, and (review round 1) a member's
// device leaving the deleted notebook and a note typed offline in a deleted
// notebook landing in the default notebook. Disposable @example.test
// accounts; prints no secrets.
//
// CONVEX_DEPLOYMENT selects the development deployment, CONVEX_SITE_URL and
// CONVEX_CLOUD_URL its URLs, NOTES_APP_URL the app (served with those URLs),
// NOTES_BACKEND_DIR the backend checkout. The deployment must run this
// branch's backend (notebooks.remove and notebooks.deletePreview).
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
const shots = process.env.SCREENSHOT_DIR;
const shot = (page, name) =>
  shots ? page.screenshot({ path: `${shots}/${name}.png` }) : undefined;
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

/** The one-time passkey offer after a password sign-in would cover rows. */
async function dismissPasskeyOffer(page) {
  await page
    .getByRole("button", { name: "Not now" })
    .click({ timeout: 15_000 })
    .catch(() => undefined);
}

/** Create an account from an emailed link and wait until it is connected. */
async function createAccount(page, link, name, password) {
  await page.goto(link);
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel(/Choose a password/).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(app + "/", { timeout: 20_000 });
  await connected(page);
  await dismissPasskeyOffer(page);
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

async function context(browser, options = {}) {
  const made = await browser.newContext(options);
  await made.addInitScript(
    ({ site, cloud }) => {
      window.__palladianTest = { site, cloud };
    },
    { site, cloud },
  );
  return made;
}

const browser = await chromium.launch({ headless: true });
try {
  const desk = await context(browser);
  const page = await desk.newPage();
  const email = `notebooks-${randomBytes(4).toString("hex")}@example.test`;
  const password = randomBytes(18).toString("base64url");
  await createAccount(page, setupLink(email), "Ada", password);
  const me = await convex(page, "query", "account:me", {});
  const notesId = me.defaultNotebookId;
  const journal = await convex(page, "mutation", "notebooks:create", {
    name: "Journal",
  });
  const archive = await convex(page, "mutation", "notebooks:create", {
    name: "Archive",
  });
  for (const title of ["Monday", "Tuesday"])
    await convex(page, "mutation", "notes:createFromMarkdown", {
      notebookId: journal,
      markdown: `${title}\n\nWhat happened on ${title}.`,
    });
  const nav = page.locator("aside.navigation");
  const navItem = (name) => nav.getByRole("button", { name, exact: true });
  const count = (name) =>
    nav.locator(".nav-row", { has: navItem(name) }).locator(".nav-count");
  await expect(count("Journal")).toHaveText("2", { timeout: 20_000 });
  await expect(count("Archive")).toHaveText("0");
  step("account with Journal (two notes) and an empty Archive");

  // Rename and describe from the sidebar's right-click menu.
  await navItem("Journal").click({ button: "right" });
  const menu = (name) =>
    page.getByRole("dialog", { name: `Actions for notebook ${name}` });
  await expect(menu("Journal").getByRole("menuitem")).toHaveText([
    "New note here",
    "Name and description…",
    "Sharing and members…",
    "Set as default",
    "Delete notebook…",
  ]);
  await shot(page, "desktop-notebook-menu");
  await menu("Journal")
    .getByRole("menuitem", { name: "Name and description…" })
    .click();
  // The dialog is named after the notebook, so it follows the rename.
  const editor = page.getByRole("dialog", { name: /^(Journal|Diary)$/ });
  const nameField = editor.getByLabel("Name", { exact: true });
  await expect(nameField).toBeFocused({ timeout: 10_000 });
  await nameField.fill("Diary");
  await editor.getByLabel(/Description/).fill("One note per day.");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(navItem("Diary")).toBeVisible({ timeout: 20_000 });
  await editor.getByRole("button", { name: "Done" }).click();
  const books = await convex(page, "query", "library:notebooks", {});
  assert.equal(
    books.find((b) => b.id === journal).description,
    "One note per day.",
  );
  step("right-click → Name and description renames and describes Journal");

  // Set as default from the hover "…".
  await navItem("Diary").hover();
  await nav
    .locator(".nav-row", { has: navItem("Diary") })
    .locator(".nav-more")
    .click();
  await menu("Diary").getByRole("menuitem", { name: "Set as default" }).click();
  await expect(page.getByText(/now go to “Diary”/)).toBeVisible();
  await expect
    .poll(
      async () =>
        (await convex(page, "query", "account:me", {})).defaultNotebookId,
      { timeout: 20_000 },
    )
    .toBe(journal);
  await navItem("Diary").click({ button: "right" });
  await expect(
    menu("Diary").getByRole("menuitem", { name: "Set as default" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  step("hover … → Set as default; the default no longer offers it");

  // New note here, from the list header's "…".
  await navItem("Diary").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Diary");
  await nav.getByRole("button", { name: /^All Notes/ }).click();
  await navItem("Archive").click();
  await page.getByRole("button", { name: "Notebook actions" }).click();
  await menu("Archive")
    .getByRole("menuitem", { name: "New note here" })
    .click();
  const text = page.getByRole("textbox", { name: "Note content" });
  await expect(text).toBeVisible({ timeout: 20_000 });
  await text.click();
  await page.keyboard.type("Filed from the menu");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(count("Archive")).toHaveText("1", { timeout: 20_000 });
  const filed = await convex(page, "query", "library:recent", {
    notebookId: archive,
  });
  assert.deepEqual(
    filed.notes.map((n) => n.title),
    ["Filed from the menu"],
  );
  step("header … → New note here creates the note in that notebook");

  // The default notebook asks for another default before it can go.
  await navItem("Diary").click({ button: "right" });
  await menu("Diary")
    .getByRole("menuitem", { name: "Delete notebook…" })
    .click();
  const deleteDiary = page.getByRole("dialog", { name: "Delete “Diary”" });
  await expect(deleteDiary).toContainText("is your default notebook");
  await deleteDiary.getByLabel("Default notebook").selectOption(notesId);
  await expect(
    deleteDiary.getByRole("group", { name: "Its notes" }),
  ).toBeVisible({ timeout: 20_000 });
  await deleteDiary.getByRole("button", { name: "Done" }).click();
  step("deleting the default notebook asks for another default first");

  // A member, Bea, reads Diary.
  const invitation = await convex(page, "mutation", "invitations:create", {
    email: `bea-${randomBytes(4).toString("hex")}@example.test`,
    notebookId: journal,
    role: "read",
  });
  assert.equal(invitation.kind, "invited");
  const beaContext = await context(browser);
  const bea = await beaContext.newPage();
  await createAccount(
    bea,
    `${app}/invite#${invitation.token}`,
    "Bea",
    randomBytes(18).toString("base64url"),
  );
  const beaNav = bea.locator("aside.navigation");
  await expect(beaNav.getByRole("button", { name: /^Diary/ })).toBeVisible({
    timeout: 20_000,
  });
  await expect(bea.getByRole("button", { name: /^Monday\b/ })).toBeVisible({
    timeout: 20_000,
  });
  // A member's menu has no owner actions.
  await beaNav.getByRole("button", { name: /^Diary/ }).click({
    button: "right",
  });
  await expect(menu("Diary").getByRole("menuitem")).toHaveText(["Members…"]);
  await bea.keyboard.press("Escape");
  // Bea keeps Diary's list open while Ada deletes it.
  await beaNav.getByRole("button", { name: /^Diary/ }).click();
  await expect(bea.getByRole("heading", { level: 1 })).toHaveText("Diary");
  step("Bea joins Diary as a reader; her menu offers only Members");

  // Ada deletes Diary, moving its notes to Archive; Bea is warned about.
  await navItem("Diary").click({ button: "right" });
  await menu("Diary")
    .getByRole("menuitem", { name: "Delete notebook…" })
    .click();
  await expect(deleteDiary).toContainText("Its 2 notes");
  await deleteDiary
    .getByLabel("Move them to", { exact: true })
    .selectOption(archive);
  await expect(deleteDiary).toContainText(
    "Bea will lose access to the notes they open through “Diary”.",
    { timeout: 20_000 },
  );
  await shot(page, "desktop-delete-warning");
  await deleteDiary.getByRole("button", { name: "Delete notebook" }).click();
  await expect(page.getByText("Deleted “Diary”")).toBeVisible({
    timeout: 30_000,
  });
  await expect(navItem("Diary")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Archive");
  await expect(count("Archive")).toHaveText("3", { timeout: 20_000 });
  await expect(page.getByRole("button", { name: /^Monday\b/ })).toBeVisible();
  await expect(beaNav.getByRole("button", { name: /^Diary/ })).toHaveCount(0, {
    timeout: 20_000,
  });
  await expect(bea.getByRole("button", { name: /^Monday\b/ })).toHaveCount(0, {
    timeout: 20_000,
  });
  // Review round 1, F1: Bea's device stops showing the deleted notebook.
  await expect(bea.getByRole("heading", { level: 1 })).toHaveText("All notes", {
    timeout: 20_000,
  });
  step(
    "Delete with move: the warning names Bea; notes land in Archive; Bea's list leaves Diary",
  );

  // Delete to Trash: notes go to Trash and restore into the chosen notebook.
  const scratch = await convex(page, "mutation", "notebooks:create", {
    name: "Scratch",
  });
  await convex(page, "mutation", "notes:createFromMarkdown", {
    notebookId: scratch,
    markdown: "Draft idea\n\nMaybe later.",
  });
  await expect(count("Scratch")).toHaveText("1", { timeout: 20_000 });
  await navItem("Scratch").click({ button: "right" });
  await menu("Scratch")
    .getByRole("menuitem", { name: "Delete notebook…" })
    .click();
  const deleteScratch = page.getByRole("dialog", {
    name: "Delete “Scratch”",
  });
  await deleteScratch.getByLabel("Move them to Trash", { exact: true }).check();
  await deleteScratch
    .getByLabel("Restoring a note puts it in")
    .selectOption(notesId);
  await deleteScratch.getByRole("button", { name: "Delete notebook" }).click();
  await expect(page.getByText("Deleted “Scratch”")).toBeVisible({
    timeout: 30_000,
  });
  await navItem("Trash").click();
  const idea = page.getByRole("button", { name: /^Draft idea\b/ });
  await expect(idea).toBeVisible({ timeout: 20_000 });
  await idea.click({ button: "right" });
  await page
    .getByRole("dialog", { name: "Actions for Draft idea" })
    .getByRole("menuitem", { name: "Restore" })
    .click();
  await navItem("Notes").click();
  await expect(idea).toBeVisible({ timeout: 20_000 });
  step("Delete to Trash: its note is in Trash and restores into Notes");

  // The same account on a phone: a long press in the navigation sheet.
  const phoneContext = await context(browser, {
    ...devices["iPhone 15 Plus"],
  });
  const phone = await phoneContext.newPage();
  await phone.goto(app + "/");
  await phone.getByLabel("Email", { exact: true }).fill(email);
  await phone.getByLabel("Password", { exact: true }).fill(password);
  await phone.getByRole("button", { name: "Sign in", exact: true }).click();
  await connected(phone);
  await dismissPasskeyOffer(phone);
  await phone.getByRole("button", { name: "Menu" }).click();
  const sheet = phone.getByRole("dialog", { name: "Navigation" });
  const archiveItem = sheet.getByRole("button", {
    name: "Archive",
    exact: true,
  });
  await expect(archiveItem).toBeVisible({ timeout: 20_000 });
  const box = await archiveItem.boundingBox();
  const cdp = await phone.context().newCDPSession(phone);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  await phone.waitForTimeout(650);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  const phoneMenu = phone.getByRole("dialog", {
    name: "Actions for notebook Archive",
  });
  await expect(phoneMenu).toBeVisible();
  await shot(phone, "phone-notebook-sheet");
  await expect(phoneMenu.getByRole("menuitem")).toHaveText([
    "New note here",
    "Name and description…",
    "Sharing and members…",
    "Set as default",
    "Delete notebook…",
  ]);
  await phoneMenu
    .getByRole("menuitem", { name: "Sharing and members…" })
    .click();
  const members = phone.getByRole("dialog", { name: "Archive", exact: true });
  await expect(members.getByText("People and agents with access")).toBeVisible({
    timeout: 20_000,
  });
  await members.getByRole("button", { name: "Done" }).click();
  step("phone: a long press on a notebook opens its sheet; Sharing opens");

  // Review round 1, F1/F3: a note typed offline in a notebook that is
  // deleted meanwhile lands in the default notebook instead of being lost.
  await convex(page, "mutation", "notebooks:create", { name: "Later" });
  await phone.getByRole("button", { name: "Menu" }).click();
  const laterItem = sheet.getByRole("button", { name: "Later", exact: true });
  await expect(laterItem).toBeVisible({ timeout: 20_000 });
  await laterItem.click();
  await expect(phone.getByRole("heading", { level: 1 })).toHaveText("Later");
  await phoneContext.setOffline(true);
  await phone
    .locator(".mobile-home-actions")
    .getByRole("button", { name: "New note" })
    .click();
  const offlineText = phone.getByRole("textbox", { name: "Note content" });
  await expect(offlineText).toBeVisible({ timeout: 20_000 });
  await offlineText.click();
  await phone.keyboard.type("Offline in Later");
  await expect(
    phone.getByText(
      /Offline — changes kept on this device|Draft saved on this device|Saving…/,
    ),
  ).toBeVisible({ timeout: 15_000 });
  await phone.waitForTimeout(800); // journal writes are batched for 200 ms
  await navItem("Later").click({ button: "right" });
  await menu("Later")
    .getByRole("menuitem", { name: "Delete notebook…" })
    .click();
  const deleteLater = page.getByRole("dialog", { name: "Delete “Later”" });
  await deleteLater.getByRole("button", { name: "Delete notebook" }).click();
  await expect(page.getByText("Deleted “Later”")).toBeVisible({
    timeout: 30_000,
  });
  await phoneContext.setOffline(false);
  await expect
    .poll(
      async () =>
        (
          await convex(page, "query", "library:recent", {
            notebookId: notesId,
          })
        ).notes.map((n) => n.title),
      { timeout: 60_000 },
    )
    .toContain("Offline in Later");
  await expect(phone.getByRole("heading", { level: 1 })).toHaveText(
    "All notes",
    { timeout: 20_000 },
  );
  step(
    "phone: a note typed offline in a notebook deleted meanwhile lands in Notes",
  );
} finally {
  await browser.close();
}
