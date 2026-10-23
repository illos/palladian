// Real-service proof of note history (plan 08, A4): a Convex development
// deployment + the app + Chromium on a desktop and an emulated iPhone. Covers
// the version list (who, what, when) after edits by two people, reading an old
// version and comparing it with the previous and the current one, paging,
// Restore as a new note (the copy has the version's text, in the same
// notebook or the person's default one; the original note, and another
// person typing in it, are untouched), History held without a connection and
// kept open from a row with a pending journal, and that a read-only
// collaborator, or an editor whose access drops to read, never reaches
// History. In-place restore was withdrawn after review round 5 (see the
// implementation report). Prints no secrets. Disposable @example.test
// accounts only.
//
// Typing is held unsent and a connection is dropped deterministically by
// routing each page's Convex WebSocket through the script (`convexGate`), not
// by timing.
//
// CONVEX_DEPLOYMENT selects the development deployment (dev:…), NOTES_APP_URL
// the app (served with that deployment's VITE_NOTES_* URLs), NOTES_BACKEND_DIR
// the backend checkout, CONVEX_SITE_URL and CONVEX_CLOUD_URL the deployment's
// URLs; `dev-target.mjs` checks them all before anything is provisioned.
// SCREENSHOT_DIR, if set, receives pictures of the panel. HISTORY_E2E_STEPS
// (comma-separated: list, compare, f3, f2, paging, reader, phone, new-note,
// downgrade) runs only those steps after the setup. HISTORY_E2E_DEBUG logs
// page errors, failed requests and reloads.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { assertDevTarget } from "./dev-target.mjs";
import { describeFailure, redact, secret } from "./redact.mjs";

const require = createRequire(new URL("../package.json", import.meta.url));
const { chromium, devices, expect } = require("@playwright/test");
const backend =
  process.env.NOTES_BACKEND_DIR ??
  fileURLToPath(new URL("../../notes-backend", import.meta.url));
const app = process.env.NOTES_APP_URL ?? "http://localhost:5178";
/** The step running now, named in a failure report. */
let current = "start";
const begin = (name) => {
  current = name;
};
const step = (message) => console.log("✓ " + message);
const shots = process.env.SCREENSHOT_DIR;
const shot = (page, name) =>
  shots ? page.screenshot({ path: `${shots}/${name}.png` }) : undefined;
// Set by the development-target check, before anything is provisioned.
let site = "";
let cloud = "";

function setupLink(email) {
  const result = spawnSync(
    "npx",
    ["convex", "run", "provision:setupOwner", JSON.stringify({ email })],
    { cwd: backend, encoding: "utf8" },
  );
  assert.equal(result.status, 0, "setup link created");
  const out = result.stdout;
  const token = secret(JSON.parse(out.slice(out.indexOf("{"))).token);
  return `${app}/invite#${token}`;
}

/** A fresh password, registered so it is never printed. */
const password = () => secret(randomBytes(18).toString("base64url"));
const address = (name) =>
  `history-${name.toLowerCase()}-${randomBytes(4).toString("hex")}@example.test`;

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

const only = (process.env.HISTORY_E2E_STEPS ?? "").split(",").filter(Boolean);
/** Whether to run a step; a step that runs is the one a failure names. */
const wanted = (name) => {
  const run = !only.length || only.includes(name);
  if (run) begin(name);
  return run;
};

/** A Convex protocol message, parsed, or null. */
function protocol(message) {
  if (typeof message !== "string") return null;
  try {
    return JSON.parse(message);
  } catch {
    return null;
  }
}

/**
 * Routes a context's Convex WebSockets through the script, so a test can hold
 * chosen mutations (an editor's `notes:push`, a `history:restore`) unsent and
 * release them later in order, hold their answers, answer the next one with a
 * failure the client cannot interpret (as a lost answer), or drop the
 * connection and refuse new ones.
 */
/**
 * Routes a context's Convex WebSockets through the script, so a test can hold
 * chosen mutations (an editor's `notes:push`) unsent and release them later in
 * order, or drop the connection and refuse new ones.
 */
async function convexGate(context) {
  const holding = new Set();
  let held = [];
  const links = new Set();
  let refusing = false;
  await context.routeWebSocket(/\/api\/[^/]+\/sync$/, (ws) => {
    if (refusing) return void ws.close();
    const server = ws.connectToServer();
    const link = { ws, server };
    links.add(link);
    ws.onClose(() => {
      links.delete(link);
      server.close();
    });
    ws.onMessage((message) => {
      const data = protocol(message);
      const path = data?.type === "Mutation" ? data.udfPath : null;
      if (path && holding.has(path))
        held.push({ path, send: () => server.send(message) });
      else server.send(message);
    });
  });
  return {
    hold(path) {
      holding.add(path);
    },
    held(path) {
      return held.filter((item) => item.path === path).length;
    },
    release(path) {
      holding.delete(path);
      for (const item of held) if (item.path === path) item.send();
      held = held.filter((item) => item.path !== path);
    },
    disconnect() {
      refusing = true;
      for (const { ws, server } of links) {
        ws.close();
        server.close();
      }
      links.clear();
    },
    reconnect() {
      refusing = false;
    },
  };
}

async function newContext(options = {}) {
  const context = await browser.newContext(options);
  await context.addInitScript(
    ({ site, cloud }) => {
      window.__palladianTest = { site, cloud };
    },
    { site, cloud },
  );
  context.gate = await convexGate(context);
  return context;
}

/** With HISTORY_E2E_DEBUG set, report page errors, failed requests and reloads. */
function watch(page, name) {
  if (!process.env.HISTORY_E2E_DEBUG) return;
  // Page text can carry links, tokens or note content: only redacted, short.
  const log = (text) => console.log(`[${name}] ${redact(text).slice(0, 300)}`);
  page.on("pageerror", (error) => log(`page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      log(`console ${message.type()}: ${message.text()}`);
  });
  page.on("requestfailed", (request) =>
    log(`request failed: ${new URL(request.url()).pathname}`),
  );
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame())
      log(`navigated: ${new URL(frame.url()).pathname}`);
  });
}

/** Creates an account from an invitation or setup link; returns its page. */
async function acceptLink(context, link, name, password) {
  const page = await context.newPage();
  watch(page, name);
  await page.goto(link);
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel(/Choose a password/).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(app + "/", { timeout: 20_000 });
  await connected(page);
  await dismissPasskeyOffer(page);
  return page;
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
      if (body.status !== "success")
        throw new Error(
          `${body.errorMessage} ${JSON.stringify(body.errorData ?? null)}`,
        );
      return body.value;
    },
    { kind, path, args },
  );
}

/**
 * Types at the end of the note as a person would: click into its last block,
 * go to the very end, and let the editor take up that selection first. (Setting
 * the DOM selection directly and typing at once raced the editor: once the
 * words landed at the start of the note.)
 */
async function typeAtEnd(page, editor, text) {
  await editor.locator(":scope > *").last().click();
  await page.keyboard.press("Control+End");
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => setTimeout(resolve, 0)),
      ),
  );
  await page.keyboard.type(text);
}

/** Opens a note from the list and waits until it can be typed into. */
async function openNote(page, title, editable = true) {
  await page
    .getByRole("button", { name: new RegExp(`^${title}\\b`) })
    .first()
    .click();
  const editor = page.getByRole("textbox", { name: "Note content" });
  await expect(editor).toBeVisible({ timeout: 20_000 });
  if (editable)
    await expect(editor).toHaveAttribute("contenteditable", "true", {
      timeout: 20_000,
    });
  return editor;
}

async function saved(page) {
  await expect(page.locator(".save-status")).toHaveText("Saved", {
    timeout: 20_000,
  });
}

// Anything thrown outside the steps is reported the same safe way.
process.on("unhandledRejection", (failure) => {
  console.error(
    `history-e2e failed during "${current}": ${describeFailure(failure)}`,
  );
  process.exit(1);
});

const browser = await chromium.launch({ headless: true });
try {
  // Everything must point at one development deployment, checked before any
  // account is provisioned: the environment and the CLI's env files, the
  // CLI's effective deployment, and the app's actual endpoints.
  begin("development target");
  const target = await assertDevTarget({
    env: process.env,
    backendDir: backend,
    browser,
    appUrl: app,
  });
  site = target.site;
  cloud = target.cloud;
  step(`everything points at the development deployment ${target.name}`);

  begin("setup");
  // Ada owns the note; Cy may edit it; Bo may only read it.
  const adaEmail = address("ada");
  const adaPassword = password();
  const deskA = await newContext();
  const a = await acceptLink(deskA, setupLink(adaEmail), "Ada", adaPassword);
  const { noteId } = await convex(a, "mutation", "notes:createFromMarkdown", {
    markdown: "Recipe\n\nFirst line.",
  });
  const invite = async (role) =>
    (
      await convex(a, "mutation", "invitations:create", {
        email: address(role),
        noteId,
        role,
      })
    ).token;

  const cyLink = `${app}/invite#${secret(await invite("edit"))}`;
  const boLink = `${app}/invite#${secret(await invite("read"))}`;
  const deskC = await newContext();
  const c = await acceptLink(deskC, cyLink, "Cy", password());
  step("Ada's note, shared with Cy (can edit) by invitation");

  const editorA = await openNote(a, "Recipe");
  await typeAtEnd(a, editorA, " Ada's first edit.");
  await saved(a);
  const editorC = await openNote(c, "Recipe");
  await expect(editorC).toContainText("Ada's first edit.", { timeout: 20_000 });
  await typeAtEnd(c, editorC, " Cy was here.");
  await saved(c);
  await expect(editorA).toContainText("Cy was here.", { timeout: 20_000 });
  await typeAtEnd(a, editorA, "\nAda's second line.");
  await saved(a);
  await expect(editorC).toContainText("Ada's second line.", {
    timeout: 20_000,
  });
  // Every edit went to the end: the note's first line is still its title.
  assert.match(
    (await editorA.innerText()).replace(/\n+/g, "\n").trim(),
    /^Recipe\nFirst line\. Ada's first edit\. Cy was here\.\nAda's second line\.$/,
  );
  step("edits by Ada, then Cy, then Ada again");

  const history = a.getByRole("dialog", { name: "History of Recipe" });
  const rows = history.locator(".history-row");
  const versionText = history.getByRole("document", { name: "Version text" });
  const changes = history.getByRole("document", { name: "Changes" });
  const newNoteButton = history.getByRole("button", {
    name: "Restore as a new note…",
  });
  const offline = history.getByText(
    "Not connected. Restore when the connection is back.",
  );
  const recipeRow = a.getByRole("button", { name: /^Recipe\b/ }).first();
  const openHistory = async () => {
    await a.getByRole("button", { name: "Note history" }).click();
    // The panel loads on first use; a cold dev server compiles it first.
    await expect(history).toBeVisible({ timeout: 20_000 });
    await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  };
  const closeHistory = async () => {
    await history.getByRole("button", { name: "Done" }).click();
    await expect(history).toBeHidden();
  };

  if (wanted("list")) {
    await openHistory();
    await expect(rows).toHaveCount(4, { timeout: 20_000 });
    const expected = [
      ["Ada", "Edited"],
      ["Cy", "Edited"],
      ["Ada", "Edited"],
      ["Ada", "Created"],
    ];
    for (const [index, [who, what]] of expected.entries()) {
      const row = rows.nth(index);
      await expect(row.locator("strong")).toHaveText(who);
      await expect(row.locator(".history-row-what")).toHaveText(what);
      await expect(row.locator("time")).toHaveText(/^Today \d/);
      await expect(row.getByText("Agent")).toHaveCount(0);
    }
    await expect(rows.first()).toContainText("Current");
    await expect(rows.nth(1)).not.toContainText("Current");
    // The same versions, from the server.
    const listed = await convex(a, "query", "history:list", { noteId });
    assert.deepEqual(
      listed.versions.map((v) => [v.actorName, v.kind, v.actorKind]),
      [
        ["Ada", "edit", "human"],
        ["Cy", "edit", "human"],
        ["Ada", "edit", "human"],
        ["Ada", "create", "human"],
      ],
    );
    for (const [index, version] of listed.versions.entries())
      await expect(rows.nth(index).locator("time")).toHaveAttribute(
        "datetime",
        new Date(version.startedAt).toISOString(),
      );
    await shot(a, "desktop-history-list");
    await closeHistory();
    step("History lists who, what and when for each version, newest first");
  }

  if (wanted("compare")) {
    await openHistory();
    // Cy's version, read-only, then compared.
    await rows.nth(1).click();
    await expect(versionText).toContainText("Cy was here.", {
      timeout: 20_000,
    });
    await expect(versionText).not.toContainText("Ada's second line.");
    await expect(versionText.locator("[contenteditable]")).toHaveCount(0);
    await history.getByRole("button", { name: "vs Previous" }).click();
    await expect(changes.locator("ins")).toHaveText(["Cy was here."], {
      timeout: 20_000,
    });
    await expect(changes.locator("del")).toHaveCount(0);
    await expect(changes).toContainText("Ada's first edit.");
    await shot(a, "desktop-history-vs-previous");
    await history.getByRole("button", { name: "vs Current" }).click();
    await expect(changes.locator("ins")).toContainText(["Ada's second line."], {
      timeout: 20_000,
    });
    await expect(changes.locator("del")).toHaveCount(0);
    // The first version, compared with nothing before it.
    await rows.nth(3).click();
    await history.getByRole("button", { name: "vs Previous" }).click();
    await expect(
      history.getByText(/compared with an empty note/),
    ).toBeVisible();
    await expect(changes.locator("ins")).toContainText(["Recipe"]);
    await closeHistory();
    step(
      "an old version reads read-only, and compares with the previous and current",
    );
  }

  if (wanted("f3")) {
    // Ada's typing is held unsent, so this device journals it and the note's
    // row is a draft of a server note. History opened from that row stays.
    deskA.gate.hold("notes:push");
    await typeAtEnd(a, editorA, " Pending row.");
    await expect(recipeRow).toContainText("Unsaved changes", {
      timeout: 10_000,
    });
    await recipeRow.click({ button: "right" });
    await a
      .getByRole("dialog", { name: "Actions for Recipe" })
      .getByRole("menuitem", { name: "History" })
      .click();
    await expect(history).toBeVisible({ timeout: 20_000 });
    await expect(rows.first()).toBeVisible({ timeout: 20_000 });
    await a.waitForTimeout(2_000);
    await expect(history).toBeVisible();
    await expect(recipeRow).toContainText("Unsaved changes");
    assert.ok(deskA.gate.held("notes:push") >= 1, "Ada's typing was held");
    await closeHistory();
    deskA.gate.release("notes:push");
    await saved(a);
    await expect(recipeRow).not.toContainText("Unsaved changes", {
      timeout: 20_000,
    });
    step(
      "review F3: History opened from a row with a pending journal stays open",
    );
  }

  if (wanted("f2")) {
    await openHistory();
    await rows.nth(2).click();
    await expect(newNoteButton).toBeEnabled({ timeout: 20_000 });
    deskA.gate.disconnect();
    await expect(a.getByTestId("session-status")).toContainText(
      "server unreachable",
      { timeout: 20_000 },
    );
    await expect(offline).toBeVisible();
    await expect(newNoteButton).toBeDisabled();
    await closeHistory();
    await expect(a.getByRole("button", { name: "Note history" })).toHaveCount(
      0,
    );
    await a.getByRole("button", { name: "More actions" }).click();
    const aMenu = a.getByRole("dialog", { name: "Actions for Recipe" });
    await expect(aMenu).toBeVisible();
    await expect(aMenu.getByRole("menuitem", { name: "History" })).toHaveCount(
      0,
    );
    await a.keyboard.press("Escape");
    deskA.gate.reconnect();
    await expect(a.getByTestId("session-status")).not.toContainText(
      "server unreachable",
      { timeout: 40_000 },
    );
    await openHistory();
    await rows.nth(2).click();
    await expect(offline).toBeHidden();
    await expect(newNoteButton).toBeEnabled({ timeout: 20_000 });
    await closeHistory();
    step(
      "review F2: losing the connection holds Restore as a new note and hides History; both return with the connection",
    );
  }

  if (wanted("paging")) {
    // More versions than one page holds.
    const paging = await convex(a, "mutation", "notes:createFromMarkdown", {
      markdown: "Paging\n\nStart.",
    });
    let revision = (
      await convex(a, "mutation", "notes:edit", {
        noteId: paging.noteId,
        edits: [{ type: "append", markdown: "An edit." }],
      })
    ).revision;
    for (let i = 0; i < 31; i++)
      revision = (
        await convex(a, "mutation", "history:restore", {
          noteId: paging.noteId,
          revision: 0,
          expectedRevision: revision,
          requestId: `paging-${i}-${randomBytes(6).toString("hex")}`,
        })
      ).revision;
    await openNote(a, "Paging");
    await a.getByRole("button", { name: "Note history" }).click();
    const pagingHistory = a.getByRole("dialog", { name: "History of Paging" });
    const pagingRows = pagingHistory.locator(".history-row");
    await expect(pagingRows).toHaveCount(30, { timeout: 20_000 });
    await pagingHistory
      .getByRole("button", { name: "Show older versions" })
      .click();
    await expect(pagingRows).toHaveCount(33, { timeout: 20_000 });
    await expect(pagingRows.last().locator(".history-row-what")).toHaveText(
      "Created",
    );
    await expect(
      pagingHistory.getByRole("button", { name: "Show older versions" }),
    ).toHaveCount(0);
    // A new version while both pages show: the list stays whole.
    await convex(a, "mutation", "history:restore", {
      noteId: paging.noteId,
      revision: 0,
      expectedRevision: revision,
      requestId: `paging-new-${randomBytes(6).toString("hex")}`,
    });
    await expect(pagingRows).toHaveCount(34, { timeout: 20_000 });
    await expect(pagingRows.last().locator(".history-row-what")).toHaveText(
      "Created",
    );
    await pagingHistory.getByRole("button", { name: "Done" }).click();
    await expect(pagingHistory).toBeHidden();
    await openNote(a, "Recipe");
    step(
      "33 versions page as 30, then Show older versions shows the rest; a new one keeps the list whole",
    );
  }

  if (wanted("reader")) {
    // Bo can only read: no History anywhere, and the server refuses it.
    const deskB = await newContext();
    const b = await acceptLink(deskB, boLink, "Bo", password());
    await openNote(b, "Recipe", false);
    await expect(b.getByRole("button", { name: "Note info" })).toBeVisible({
      timeout: 20_000,
    });
    await expect(b.getByRole("button", { name: "Note history" })).toHaveCount(
      0,
    );
    await b.getByRole("button", { name: "More actions" }).click();
    const bMenu = b.getByRole("dialog", { name: "Actions for Recipe" });
    await expect(bMenu.getByRole("menuitem")).toHaveText([
      "Pin",
      "Duplicate",
      "Export as Markdown",
      "Print or save as PDF",
    ]);
    await b.keyboard.press("Escape");
    await b
      .getByRole("button", { name: /^Recipe\b/ })
      .first()
      .click({ button: "right" });
    await expect(bMenu.getByRole("menuitem")).toHaveText([
      "Pin",
      "Duplicate",
      "Share…",
      "Info",
      "Export as Markdown",
      "Print or save as PDF",
    ]);
    await b.keyboard.press("Escape");
    await assert.rejects(
      convex(b, "query", "history:list", { noteId }),
      /denied/,
    );
    step(
      "Bo (can read) is offered no History, and the server refuses his request",
    );
  }

  if (wanted("phone")) {
    // Ada on a phone: History from the "…" sheet is a full-height sheet.
    const phoneContext = await newContext({ ...devices["iPhone 15 Plus"] });
    const phone = await phoneContext.newPage();
    await phone.goto(app + "/");
    await phone.getByLabel("Email", { exact: true }).fill(adaEmail);
    await phone.getByLabel("Password", { exact: true }).fill(adaPassword);
    await phone.getByRole("button", { name: "Sign in", exact: true }).click();
    await connected(phone);
    await dismissPasskeyOffer(phone);
    await openNote(phone, "Recipe");
    await phone.getByRole("button", { name: "More actions" }).click();
    const sheet = phone.getByRole("dialog", { name: "Actions for Recipe" });
    await expect(sheet.getByRole("menuitem")).toHaveText([
      "Pin",
      "Duplicate",
      "Move…",
      "Share…",
      "History",
      "Info",
      "Export as Markdown",
      "Print or save as PDF",
      "Move to Trash",
    ]);
    await shot(phone, "phone-action-sheet");
    await sheet.getByRole("menuitem", { name: "History" }).click();
    const phoneHistory = phone.getByRole("dialog", {
      name: "History of Recipe",
    });
    await expect(phoneHistory.locator(".history-row").first()).toBeVisible({
      timeout: 20_000,
    });
    const viewport = phone.viewportSize();
    const box = await phoneHistory.boundingBox();
    assert.ok(
      box.y <= 1 &&
        box.height >= viewport.height - 1 &&
        box.width >= viewport.width - 1,
      "the phone panel fills the screen",
    );
    await shot(phone, "phone-history-list");
    await phoneHistory.locator(".history-row").nth(1).click();
    await expect(
      phoneHistory.getByRole("document", { name: "Version text" }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      phoneHistory.getByRole("region", { name: "Versions" }),
    ).toBeHidden();
    await phoneHistory.getByRole("button", { name: "vs Previous" }).click();
    await expect(
      phoneHistory.getByRole("document", { name: "Changes" }),
    ).toBeVisible({ timeout: 20_000 });
    await shot(phone, "phone-history-diff");
    await phoneHistory.getByRole("button", { name: "Versions" }).click();
    await expect(
      phoneHistory.getByRole("region", { name: "Versions" }),
    ).toBeVisible();
    await phoneHistory.getByRole("button", { name: "Done" }).click();
    await expect(phoneHistory).toBeHidden();
    step(
      "phone: History from the … sheet fills the screen, one step at a time",
    );
  }
  if (wanted("new-note")) {
    // After review round 5, Restore makes a new note from the version and
    // leaves the note itself alone. Cy keeps typing in the original
    // meanwhile: one word sent, one held unsent on his device.
    await typeAtEnd(c, editorC, " word1");
    await saved(c);
    await expect(editorA).toContainText("word1", { timeout: 20_000 });
    deskC.gate.hold("notes:push");
    await typeAtEnd(c, editorC, " word2");
    await expect(c.locator(".save-status")).toHaveText("Saving…");
    const original = (await convex(a, "query", "notes:get", { noteId }))
      .summary;
    await openHistory();
    // The first version: "Recipe" and "First line." only.
    await rows.last().click();
    await expect(versionText).toContainText("First line.", { timeout: 20_000 });
    await expect(versionText).not.toContainText("Ada's first edit.");
    await newNoteButton.click();
    await history.getByRole("button", { name: "Create note" }).click();
    await expect(history).toBeHidden({ timeout: 20_000 });
    const toast = a.locator(".toast", { hasText: "Restored as a new note" });
    await expect(toast).toBeVisible();
    await shot(a, "desktop-restored-as-new-note");
    await toast.getByRole("button", { name: "Open" }).click();
    await a.waitForURL(
      (url) =>
        url.pathname.startsWith("/notes/") && !url.pathname.endsWith(noteId),
      { timeout: 20_000 },
    );
    const copyId = new URL(a.url()).pathname.split("/").pop();
    await expect(editorA).toContainText("First line.", { timeout: 20_000 });
    await expect(editorA).not.toContainText("Ada's first edit.");
    // In the same notebook, which Ada owns.
    const copy = (await convex(a, "query", "notes:get", { noteId: copyId }))
      .summary;
    assert.equal(copy.notebookId, original.notebookId);
    // The original is untouched: Cy's unsent word is still on his screen,
    // and once sent, both his words are in it.
    await expect(editorC).toContainText("word2");
    deskC.gate.release("notes:push");
    await saved(c);
    await a.goto(`${app}/notes/${noteId}`);
    await expect(editorA).toContainText("word2", { timeout: 20_000 });
    await expect(editorA).toContainText("word1");
    await expect(editorA).toContainText("Ada's first edit.");
    // Its history has no restore in it.
    const kinds = (
      await convex(a, "query", "history:list", { noteId })
    ).versions.map((version) => version.kind);
    assert.ok(!kinds.includes("restore"), "the original was not restored");
    step(
      "Restore as a new note: the new note has the version's text in the same notebook; the original, and Cy's typing in it, are untouched",
    );

    // Cy may edit the note but not add notes to Ada's notebook: his copy
    // goes to his own default notebook.
    await c.getByRole("button", { name: "Note history" }).click();
    const cyHistory = c.getByRole("dialog", { name: "History of Recipe" });
    await expect(cyHistory.locator(".history-row").first()).toBeVisible({
      timeout: 20_000,
    });
    await cyHistory.locator(".history-row").last().click();
    await cyHistory
      .getByRole("button", { name: "Restore as a new note…" })
      .click();
    await cyHistory.getByRole("button", { name: "Create note" }).click();
    await expect(cyHistory).toBeHidden({ timeout: 20_000 });
    await c
      .locator(".toast", { hasText: "Restored as a new note" })
      .getByRole("button", { name: "Open" })
      .click();
    await c.waitForURL(
      (url) =>
        url.pathname.startsWith("/notes/") && !url.pathname.endsWith(noteId),
      { timeout: 20_000 },
    );
    const cyCopyId = new URL(c.url()).pathname.split("/").pop();
    const cyCopy = (await convex(c, "query", "notes:get", { noteId: cyCopyId }))
      .summary;
    const cy = await convex(c, "query", "account:me", {});
    assert.equal(cyCopy.notebookId, cy.defaultNotebookId);
    await c.goto(`${app}/notes/${noteId}`);
    await expect(editorC).toContainText("word2", { timeout: 20_000 });
    step(
      "Restore as a new note by an editor who cannot add notes to the notebook: the copy goes to his default notebook",
    );
  }

  if (wanted("downgrade")) {
    // Cy loses edit access while his History is open: it closes.
    const cy = await convex(c, "query", "account:me", {});
    await c.getByRole("button", { name: "Note history" }).click();
    const cyHistory = c.getByRole("dialog", { name: "History of Recipe" });
    await expect(cyHistory.locator(".history-row").first()).toBeVisible({
      timeout: 20_000,
    });
    await convex(a, "mutation", "sharing:setNoteMember", {
      noteId,
      principalId: cy.id,
      role: "read",
    });
    await expect(cyHistory).toBeHidden({ timeout: 20_000 });
    await expect(c.getByRole("button", { name: "Note history" })).toHaveCount(
      0,
      { timeout: 20_000 },
    );
    await assert.rejects(
      convex(c, "query", "history:list", { noteId }),
      /denied/,
    );
    await shot(c, "desktop-after-downgrade");
    step("Cy's open History closes when his access drops to read");
  }

  console.log("All history checks passed.");
} catch (failure) {
  // Only the step and a redacted, short message: raw failures can carry
  // invitation links, passwords or tokens.
  console.error(
    `history-e2e failed during "${current}": ${describeFailure(failure)}`,
  );
  process.exitCode = 1;
  if (process.env.HISTORY_E2E_DEBUG)
    for (const open of browser.contexts().flatMap((c) => c.pages()))
      console.error(
        redact(
          await open
            .evaluate(() =>
              JSON.stringify({
                path: location.pathname,
                dialogs: [...document.querySelectorAll("dialog")].map((d) => [
                  d.className,
                  d.open,
                ]),
                toasts: [...document.querySelectorAll(".toast")].length,
                panelFailure: !!document.querySelector(".panel-failure"),
              }),
            )
            .catch(() => "(page unavailable)"),
        ),
      );
  // A picture of each page at the failure, for the person debugging it.
  for (const [i, open] of browser
    .contexts()
    .flatMap((context) => context.pages())
    .entries())
    await open
      .screenshot({ path: `/tmp/history-e2e-failure-${i}.png` })
      .catch(() => undefined);
} finally {
  await browser.close();
}
