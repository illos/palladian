// Real-service browser proof: local Convex backend + Vite app + Chromium.
// Creates disposable accounts through the invitation flow; prints no secrets.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(new URL("../package.json", import.meta.url));
const { chromium, expect } = require("@playwright/test");
const backend = fileURLToPath(new URL("../../notes-backend", import.meta.url));
const app = process.env.NOTES_APP_URL ?? "http://localhost:5178";
const step = (message) => console.log("✓ " + message);

function setupLink(email) {
  const result = spawnSync(
    "npx",
    ["convex", "run", "provision:setupOwner", JSON.stringify({ email })],
    { cwd: backend, encoding: "utf8" },
  );
  assert.equal(result.status, 0, "setup link created");
  const json = result.stdout.slice(result.stdout.indexOf("{"));
  return `${app}/invite#${JSON.parse(json).token}`;
}

async function createAccount(context, name) {
  const email = `${name.toLowerCase()}-${randomBytes(4).toString("hex")}@example.test`;
  const password = randomBytes(18).toString("base64url");
  const page = await context.newPage();
  await page.goto(setupLink(email));
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel(/Choose a password/).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(app + "/", { timeout: 20_000 });
  await expect(page.getByTestId("session-status")).toContainText("Connected", {
    timeout: 20_000,
  });
  await liveReady(page);
  return { page, email, password };
}

/** The notebook controls appear once the live backend session is ready. */
async function liveReady(page) {
  await expect(
    page.getByRole("button", { name: "New notebook" }).first(),
  ).toBeAttached({
    timeout: 20_000,
  });
}

async function typeAtEnd(page, editor, text) {
  await editor.focus();
  // Place the caret at the end of the document, as a person tapping below the text would.
  await editor.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element.lastElementChild ?? element);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.type(text);
}

async function signIn(page, email, password) {
  await page.goto(app + "/");
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByTestId("session-status")).toContainText("Connected", {
    timeout: 20_000,
  });
  await liveReady(page);
}

const browser = await chromium.launch({ headless: true });
try {
  const contextA = await browser.newContext();
  const owner = await createAccount(contextA, "Ada");
  step("owner account created from a setup link and signed in");
  let a = owner.page;
  await expect(
    a.getByRole("button", { name: "Notes", exact: false }).first(),
  ).toBeVisible();

  await a
    .getByRole("button", { name: "New note", exact: true })
    .first()
    .click();
  let editorA = a.getByRole("textbox", { name: "Note content" });
  await expect(editorA).toHaveAttribute("contenteditable", "true", {
    timeout: 10_000,
  });
  await editorA.click();
  await a.keyboard.type("Live note\nHello from the first browser");
  await expect(a.getByText("Saved", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await a.waitForURL(/\/notes\/[A-Za-z0-9_-]+$/);
  const noteUrl = a.url();
  step(
    "new note saved to the server and addressable at " +
      new URL(noteUrl).pathname,
  );

  // Same account, second device.
  const contextB = await browser.newContext();
  const b = await contextB.newPage();
  await signIn(b, owner.email, owner.password);
  await expect(b.getByRole("button", { name: /Live note/ })).toBeVisible({
    timeout: 15_000,
  });
  await b.getByRole("button", { name: /Live note/ }).click();
  const editorB = b.getByRole("textbox", { name: "Note content" });
  await expect(editorB).toContainText("Hello from the first browser");
  await expect(editorB).toHaveAttribute("contenteditable", "true", {
    timeout: 10_000,
  });
  step("second device received the library and note text");

  // Concurrent editing converges.
  await typeAtEnd(a, editorA, " (A)");
  await typeAtEnd(b, editorB, "\nLine from B");
  if (process.env.DEBUG_LIVE) {
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const statusA = await a.locator(".save-status").innerText();
      const statusB = await b.locator(".save-status").innerText();
      console.log(
        "status",
        JSON.stringify({
          statusA,
          statusB,
          a: await editorA.innerText(),
          b: await editorB.innerText(),
        }),
      );
    }
  }
  await expect(editorA).toContainText("Line from B", { timeout: 10_000 });
  await expect(editorB).toContainText("(A)", { timeout: 10_000 });
  const textA = await editorA.innerText();
  const textB = await editorB.innerText();
  assert.equal(textA, textB, "both editors converge");
  step("concurrent edits from two browsers converged");

  // Reload restores from cache, then reconnects.
  await a.reload();
  await expect(editorA).toContainText("Line from B", { timeout: 10_000 });
  await expect(a.getByText("Saved", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  step("deep link reload reopened the note and reconnected");

  // Offline typing is journaled and sent after reconnecting.
  await contextA.setOffline(true);
  await typeAtEnd(a, editorA, "\nWritten offline");
  await expect(
    a.getByText(/Offline — changes kept on this device|Saving…/),
  ).toBeVisible({ timeout: 15_000 });
  await contextA.setOffline(false);
  await expect(editorB).toContainText("Written offline", { timeout: 30_000 });
  step("offline typing was kept and delivered after reconnecting");

  // Pending edits survive closing the page and are applied exactly once.
  await expect(a.getByText("Saved", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await contextA.setOffline(true);
  await typeAtEnd(a, editorA, "\nJournal line");
  // The Convex client queues the push while offline, so the editor reports saving.
  await expect(
    a.getByText(/Offline — changes kept on this device|Saving…/),
  ).toBeVisible({ timeout: 15_000 });
  await a.waitForTimeout(800); // journal writes are batched for 200 ms
  await a.close();
  await contextA.setOffline(false);
  a = await contextA.newPage();
  await a.goto(noteUrl);
  editorA = a.getByRole("textbox", { name: "Note content" });
  await expect(editorA).toContainText("Journal line", { timeout: 15_000 });
  await expect(a.getByText("Saved", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(editorB).toContainText("Journal line", { timeout: 20_000 });
  assert.equal(
    (await editorB.innerText()).split("Journal line").length - 1,
    1,
    "pending edit applied exactly once",
  );
  step(
    "pending offline edits survived closing the page and arrived exactly once",
  );

  // Sharing: invite a collaborator to the default notebook.
  await a
    .getByRole("button", { name: "All notes", exact: true })
    .click()
    .catch(() => {});
  await a.getByRole("button", { name: "Notes", exact: true }).first().click();
  await a.getByRole("button", { name: "Sharing" }).click();
  const friendEmail = `bo-${randomBytes(4).toString("hex")}@example.test`;
  await a
    .getByLabel("Access")
    .last()
    .selectOption("read")
    .catch(() => {});
  await a.getByLabel("Invite by email").fill(friendEmail);
  await a.getByRole("button", { name: "Invite" }).click();
  const link = await a.getByLabel("Invitation link").inputValue();
  assert.match(link, /\/invite#/);
  step("owner created an invitation link for a collaborator");

  const contextC = await browser.newContext();
  const c = await contextC.newPage();
  const friendPassword = randomBytes(18).toString("base64url");
  await c.goto(link);
  await c.getByLabel("Your name").fill("Bo");
  await c.getByLabel(/Choose a password/).fill(friendPassword);
  await c.getByLabel("Confirm password").fill(friendPassword);
  await c.getByRole("button", { name: "Create account" }).click();
  await c.waitForURL(app + "/", { timeout: 20_000 });
  await expect(c.getByRole("button", { name: /Live note/ })).toBeVisible({
    timeout: 20_000,
  });
  await c.getByRole("button", { name: /Live note/ }).click();
  await expect(c.getByRole("textbox", { name: "Note content" })).toContainText(
    "Written offline",
  );
  step("invited collaborator sees the shared notebook's notes");

  // Removing the collaborator closes their open note and removes the cached copy.
  await a.getByLabel("Access for Bo").selectOption("remove");
  await expect(
    c.getByText("You no longer have access to that note."),
  ).toBeVisible({
    timeout: 20_000,
  });
  await expect(c.getByRole("button", { name: /Live note/ })).toHaveCount(0, {
    timeout: 20_000,
  });
  const leftovers = await c.evaluate(async () => {
    const open = indexedDB.open("palladian-notes-foundation");
    const db = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const read = (table) =>
      new Promise((resolve) => {
        const request = db.transaction(table).objectStore(table).getAll();
        request.onsuccess = () =>
          resolve(request.result.map((row) => row.text ?? row.title));
      });
    return { bodies: await read("bodies"), summaries: await read("summaries") };
  });
  assert.ok(
    ![...leftovers.bodies, ...leftovers.summaries].some((value) =>
      String(value).includes("Live note"),
    ),
    "revoked note left no cached copy",
  );
  step("removing the collaborator closed the note and cleared its cached copy");

  console.log("All live checks passed.");
} finally {
  await browser.close();
}
