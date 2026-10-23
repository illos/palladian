// Real-service proof of note history (plan 08, A4): a Convex development
// deployment + the app + Chromium on a desktop and an emulated iPhone. Covers
// the version list (who, what, when) after edits by two people, reading an old
// version and comparing it with the previous and the current one, paging,
// restoring while another signed-in person is typing in the note (a refused
// restore first, then both converge; what happens to their words is checked
// word by word), and that a read-only collaborator, or an editor whose access
// drops to read, never reaches History. Review round 1 adds: Restore waits for
// this window's own unsent typing (F1) and for the connection (F2), and a
// History panel opened from a row with a pending journal stays open (F3).
// Prints no secrets. Disposable @example.test accounts only.
//
// Typing is held unsent, a restore is held in flight, and a connection is
// dropped deterministically by routing each page's Convex WebSocket through
// the script (`convexGate`), not by timing.
//
// CONVEX_DEPLOYMENT selects the development deployment (dev:…), NOTES_APP_URL
// the app (served with that deployment's VITE_NOTES_* URLs), NOTES_BACKEND_DIR
// the backend checkout, CONVEX_SITE_URL and CONVEX_CLOUD_URL the deployment's
// URLs. SCREENSHOT_DIR, if set, receives pictures of the panel.
// HISTORY_E2E_STEPS (comma-separated: list, compare, f3, f1, f2, restore,
// paging, reader, downgrade, phone) runs only those steps after the setup.
// HISTORY_E2E_DEBUG logs page errors, failed requests and reloads.
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
async function convexGate(context) {
  const holding = new Set();
  const failing = new Set();
  const holdingAnswers = new Set();
  let held = [];
  let heldAnswers = [];
  const links = new Set();
  let refusing = false;
  await context.routeWebSocket(/\/api\/[^/]+\/sync$/, (ws) => {
    if (refusing) return void ws.close();
    const server = ws.connectToServer();
    const link = { ws, server, watched: new Map() };
    links.add(link);
    ws.onClose(() => {
      links.delete(link);
      server.close();
    });
    ws.onMessage((message) => {
      const data = protocol(message);
      const path = data?.type === "Mutation" ? data.udfPath : null;
      if (path && failing.has(path)) {
        failing.delete(path);
        // As if the answer were lost: the client learns nothing it can use.
        ws.send(
          JSON.stringify({
            type: "MutationResponse",
            requestId: data.requestId,
            success: false,
            result: "Synthetic failure from the test gate",
            logLines: [],
          }),
        );
        return;
      }
      if (path && holdingAnswers.has(path))
        link.watched.set(data.requestId, path);
      if (path && holding.has(path))
        held.push({ path, args: data.args, send: () => server.send(message) });
      else server.send(message);
    });
    server.onMessage((message) => {
      const data = protocol(message);
      if (
        data?.type === "MutationResponse" &&
        link.watched.has(data.requestId)
      ) {
        heldAnswers.push(link.watched.get(data.requestId));
        return;
      }
      ws.send(message);
    });
  });
  return {
    hold(path) {
      holding.add(path);
    },
    held(path) {
      return held.filter((item) => item.path === path).length;
    },
    /** The arguments of the held mutations of this function. */
    heldArgs(path) {
      return held.filter((item) => item.path === path).map((item) => item.args);
    },
    release(path) {
      holding.delete(path);
      for (const item of held) if (item.path === path) item.send();
      held = held.filter((item) => item.path !== path);
    },
    /** Forgets held mutations unsent (their page has gone). */
    discard(path) {
      holding.delete(path);
      held = held.filter((item) => item.path !== path);
    },
    failNext(path) {
      failing.add(path);
    },
    /** Lets mutations of this function through but keeps their answers. */
    holdAnswers(path) {
      holdingAnswers.add(path);
    },
    heldAnswers(path) {
      return heldAnswers.filter((item) => item === path).length;
    },
    /** Stops keeping answers; the ones kept are never delivered. */
    dropAnswers(path) {
      holdingAnswers.delete(path);
      heldAnswers = heldAnswers.filter((item) => item !== path);
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
  const restoreButton = history.getByRole("button", {
    name: "Restore this version…",
  });
  const waiting = history.getByText(
    "Waiting for your changes in this window to save…",
  );
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
    // The newest version is the note as it is now; it cannot be restored.
    await rows.first().click();
    await expect(
      history.getByText("This is the note as it is now."),
    ).toBeVisible();
    await expect(restoreButton).toHaveCount(0);
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

  if (wanted("f1")) {
    // Ada's own typing is held unsent: Restore waits for it.
    deskA.gate.hold("notes:push");
    await typeAtEnd(a, editorA, " Unsent here.");
    await expect(a.locator(".save-status")).toHaveText("Saving…");
    await openHistory();
    await rows.nth(2).click();
    await expect(waiting).toBeVisible({ timeout: 10_000 });
    await expect(restoreButton).toBeDisabled();
    await a.waitForTimeout(1_000);
    await expect(restoreButton).toBeDisabled();
    await shot(a, "desktop-restore-waiting");
    assert.ok(deskA.gate.held("notes:push") >= 1, "Ada's typing was held");
    deskA.gate.release("notes:push");
    await expect(waiting).toBeHidden({ timeout: 20_000 });
    await expect(restoreButton).toBeEnabled();
    // What Ada typed reached the server before any restore could replace it.
    const newest = (await convex(a, "query", "history:list", { noteId }))
      .versions[0];
    const now = await convex(a, "query", "history:read", {
      noteId,
      revision: newest.revision,
    });
    assert.ok(now.markdown.includes("Unsent here."), "Ada's typing was saved");
    await closeHistory();
    step("review F1: Restore waits until this window's own typing is saved");
  }

  if (wanted("f2")) {
    await openHistory();
    await rows.nth(2).click();
    await expect(restoreButton).toBeEnabled({ timeout: 20_000 });
    deskA.gate.disconnect();
    await expect(a.getByTestId("session-status")).toContainText(
      "server unreachable",
      { timeout: 20_000 },
    );
    await expect(offline).toBeVisible();
    await expect(restoreButton).toBeDisabled();
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
    await expect(restoreButton).toBeEnabled({ timeout: 20_000 });
    await closeHistory();
    step(
      "review F2: losing the connection holds Restore and hides History; it returns with the connection",
    );
  }

  if (wanted("restore")) {
    // Restore Ada's first edit while Cy is typing. First, Cy's word lands
    // while Ada's restore is in flight: the server refuses it.
    await openHistory();
    await rows.nth(2).click();
    await expect(versionText).toContainText("Ada's first edit.", {
      timeout: 20_000,
    });
    await expect(versionText).not.toContainText("Cy was here.");
    deskA.gate.hold("history:restore");
    await restoreButton.click();
    await history.getByRole("button", { name: "Restore", exact: true }).click();
    await expect.poll(() => deskA.gate.held("history:restore")).toBe(1);
    await typeAtEnd(c, editorC, " word1");
    await saved(c);
    deskA.gate.release("history:restore");
    await expect(
      history.getByText(/The note changed before the restore/),
    ).toBeVisible({ timeout: 20_000 });
    await expect(editorC).toContainText("Ada's second line.");
    await expect(editorA).toContainText("word1", { timeout: 20_000 });
    // Now Cy types a word his device has not sent when the restore arrives.
    deskC.gate.hold("notes:push");
    await typeAtEnd(c, editorC, " word2");
    await expect(c.locator(".save-status")).toHaveText("Saving…");
    await restoreButton.click();
    await history.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(history).toBeHidden({ timeout: 20_000 });
    await expect(a.locator(".toast")).toContainText(
      "Restored the version from Today",
    );
    // Cy's editor receives the restore through collaboration.
    await expect(editorC).not.toContainText("Ada's second line.", {
      timeout: 20_000,
    });
    deskC.gate.release("notes:push");
    await a.waitForTimeout(2_000);
    await typeAtEnd(c, editorC, " After restore.");
    await saved(c);
    await expect(editorA).toContainText("After restore.", { timeout: 20_000 });
    await expect
      .poll(
        async () => (await editorA.innerText()) === (await editorC.innerText()),
        { timeout: 20_000 },
      )
      .toBe(true);
    const finalText = await editorA.innerText();
    for (const kept of [
      "Recipe",
      "First line. Ada's first edit.",
      "After restore.",
    ])
      assert.ok(finalText.includes(kept), `kept: ${kept}`);
    for (const gone of ["Cy was here.", "Ada's second line.", "word1"])
      assert.ok(!finalText.includes(gone), `restored away: ${gone}`);
    const after = await convex(a, "query", "history:list", { noteId });
    const restoreAt = after.versions.findIndex((v) => v.kind === "restore");
    assert.ok(
      restoreAt > 0,
      "Cy's later typing is a version after the restore",
    );
    const restored = after.versions[restoreAt];
    assert.equal(restored.actorName, "Ada");
    assert.equal(after.versions[0].actorName, "Cy");
    // word1 reached the server before the restore: it is in History.
    const before = await convex(a, "query", "history:read", {
      noteId,
      revision: restored.baseRevision,
    });
    assert.ok(before.markdown.includes("word1"), "word1 is in History");
    // word2 had not left Cy's device. The restore replaced the whole note, and
    // his editor's unsent steps were rebased onto it and dropped: the word is
    // neither in the note nor in History. This is collaboration behaviour in
    // the fundamentals, reported as found (review round 1, F1).
    assert.ok(!before.markdown.includes("word2"), "word2 was never saved");
    assert.ok(
      !finalText.includes("word2"),
      "word2 did not survive the restore",
    );
    const server = await convex(a, "query", "history:read", {
      noteId,
      revision: after.versions[0].revision,
    });
    assert.ok(server.markdown.includes("After restore."));
    assert.ok(server.markdown.includes("First line. Ada's first edit."));
    assert.ok(!server.markdown.includes("Ada's second line."));
    assert.ok(!server.markdown.includes("word2"));
    step(
      "a refused restore, then a restore while Cy types: both converge and Cy's later typing stays",
    );
    step(
      "documented, not changed: Cy's word typed but unsent when the restore arrived is lost; his saved word is in History",
    );
  }

  if (wanted("r2-1")) {
    // Review round 2, R2-1: Ada's restore is held in flight. History cannot
    // be dismissed and the note is read-only here; after the patience time
    // History may close, but the note stays read-only, so typing (with its
    // push held, as the reviewer did) cannot start; then the restore lands
    // and editing resumes.
    await openHistory();
    await rows.nth(1).click();
    await expect(versionText).not.toContainText("After restore.", {
      timeout: 20_000,
    });
    deskA.gate.hold("history:restore");
    await restoreButton.click();
    await history.getByRole("button", { name: "Restore", exact: true }).click();
    await expect.poll(() => deskA.gate.held("history:restore")).toBe(1);
    await a.keyboard.press("Escape");
    await expect(history).toBeVisible();
    await expect(history.getByRole("button", { name: "Done" })).toBeDisabled();
    await expect(
      history.getByRole("button", { name: "Restoring…" }),
    ).toBeDisabled();
    await expect(editorA).toHaveAttribute("contenteditable", "false");
    await expect(a.locator(".save-status")).toHaveText(/^Restoring a version/);
    await expect(history.getByText(/^Still restoring/)).toBeVisible({
      timeout: 30_000,
    });
    await shot(a, "desktop-restore-stalled");
    await closeHistory();
    await expect(editorA).toHaveAttribute("contenteditable", "false");
    deskA.gate.hold("notes:push");
    await editorA.click();
    await a.keyboard.press("Control+End");
    await a.keyboard.type(" Typed while restoring.");
    await a.waitForTimeout(1_000);
    await expect(editorA).not.toContainText("Typed while restoring.");
    assert.equal(deskA.gate.held("notes:push"), 0, "nothing was typed");
    deskA.gate.release("history:restore");
    await expect(a.locator(".toast")).toContainText(
      "Restored the version from Today",
      { timeout: 20_000 },
    );
    await expect(editorA).not.toContainText("After restore.", {
      timeout: 20_000,
    });
    await expect(editorA).toHaveAttribute("contenteditable", "true", {
      timeout: 20_000,
    });
    deskA.gate.release("notes:push");
    await typeAtEnd(a, editorA, " Resumed.");
    await saved(a);
    const newest = (await convex(a, "query", "history:list", { noteId }))
      .versions[0];
    const now = await convex(a, "query", "history:read", {
      noteId,
      revision: newest.revision,
    });
    assert.ok(now.markdown.includes("Resumed."), "typing resumed and saved");
    assert.ok(!now.markdown.includes("After restore."), "the restore applied");
    step(
      "review R2-1: while a restore is in flight, History stays open and the note stays read-only, even after History closes",
    );
  }

  /** How many restores the note's history has, from the server. */
  const restoreCount = async () =>
    (
      await convex(a, "query", "history:list", { noteId, limit: 100 })
    ).versions.filter((version) => version.kind === "restore").length;
  /** The unresolved restores this browser has recorded. */
  const recorded = (page) =>
    page.evaluate(() =>
      JSON.parse(
        localStorage.getItem("palladian.notes.pending-restores.v1") ?? "[]",
      ),
    );
  const sendRestore = async () => {
    await restoreButton.click();
    await history.getByRole("button", { name: "Restore", exact: true }).click();
  };

  if (wanted("r3-1")) {
    // Review round 3, R3-1: the hold is the note's, not one opening's, and it
    // survives a reload until the restore's outcome is known.
    await convex(a, "mutation", "notes:createFromMarkdown", {
      markdown: "Second note\n\nSomething else.",
    });
    await expect(
      a.getByRole("button", { name: /^Second note\b/ }).first(),
    ).toBeVisible({ timeout: 20_000 });
    // A marker the restore takes away: the version before it lacks it.
    await typeAtEnd(a, editorA, " R3 marker.");
    await saved(a);
    const before = await restoreCount();
    await openHistory();
    await rows.nth(1).click();
    await expect(versionText).not.toContainText("R3 marker.", {
      timeout: 20_000,
    });
    deskA.gate.hold("history:restore");
    await sendRestore();
    await expect.poll(() => deskA.gate.held("history:restore")).toBe(1);
    const [sent] = deskA.gate.heldArgs("history:restore");
    await expect(history.getByText(/^Still restoring/)).toBeVisible({
      timeout: 30_000,
    });
    await closeHistory();
    // The reviewer's scenario: another note, then back.
    await openNote(a, "Second note");
    await recipeRow.click();
    await expect(editorA).toContainText("R3 marker.", { timeout: 20_000 });
    await expect(editorA).toHaveAttribute("contenteditable", "false");
    await expect(a.locator(".save-status")).toHaveText(/^Restoring a version/);
    await editorA.click();
    await a.keyboard.press("Control+End");
    await a.keyboard.type(" Typed after returning.");
    await a.waitForTimeout(1_000);
    await expect(editorA).not.toContainText("Typed after returning.");
    // A reload while the restore is unanswered: its request never reached
    // the server, but the record did reach storage, so the note stays held.
    const stored = await recorded(a);
    assert.equal(stored.length, 1, "the restore is recorded");
    deskA.gate.discard("history:restore");
    deskA.gate.hold("history:restore");
    await a.reload();
    await expect(editorA).toContainText("R3 marker.", { timeout: 20_000 });
    await expect(editorA).toHaveAttribute("contenteditable", "false");
    await expect(a.locator(".save-status")).toHaveText(/^Restoring a version/);
    // Once connected, the same request is sent again to reconcile.
    await expect
      .poll(() => deskA.gate.held("history:restore"), { timeout: 20_000 })
      .toBe(1);
    const [again] = deskA.gate.heldArgs("history:restore");
    assert.deepEqual(again, sent, "reconciling sends the same request");
    await shot(a, "desktop-restore-reconciling");
    deskA.gate.release("history:restore");
    await expect(a.locator(".toast")).toContainText(
      "Restored the version from Today",
      { timeout: 20_000 },
    );
    await expect(editorA).toHaveAttribute("contenteditable", "true", {
      timeout: 20_000,
    });
    await expect(editorA).not.toContainText("R3 marker.");
    assert.equal(await restoreCount(), before + 1, "applied once");
    assert.deepEqual(await recorded(a), [], "the record is cleared");
    step(
      "review R3-1: switching notes keeps the restore's note read-only; after a reload the hold stays until the same request is reconciled",
    );

    // An answer the client cannot use: the note stays held, says so, and
    // Check again resolves it.
    await openHistory();
    // The version with the marker, so the restore visibly changes the note.
    await rows.nth(1).click();
    await expect(versionText).toContainText("R3 marker.", { timeout: 20_000 });
    deskA.gate.failNext("history:restore");
    await sendRestore();
    await expect(
      history.getByText(/did not reach the server, so it is not confirmed/),
    ).toBeVisible({ timeout: 20_000 });
    await closeHistory();
    await expect(a.locator(".save-status")).toHaveText(
      "Restoring a version — not confirmed yet",
    );
    await expect(editorA).toHaveAttribute("contenteditable", "false");
    assert.equal(await restoreCount(), before + 1, "nothing applied yet");
    assert.equal((await recorded(a)).length, 1, "still recorded");
    await a.getByRole("button", { name: "Check again" }).click();
    await expect
      .poll(() => restoreCount(), { timeout: 20_000 })
      .toBe(before + 2);
    await expect(editorA).toContainText("R3 marker.", { timeout: 20_000 });
    await expect(editorA).toHaveAttribute("contenteditable", "true", {
      timeout: 20_000,
    });
    assert.deepEqual(await recorded(a), []);
    step(
      "review R3-1: an unconfirmed restore holds the note, says so, and Check again resolves it",
    );
  }

  if (wanted("r3-1-replay")) {
    // The restore reaches the server but its answer is lost: after a reload,
    // reconciling gets the first result back from the server's receipt; it
    // is not applied twice.
    await typeAtEnd(a, editorA, " Replay marker.");
    await saved(a);
    const before = await restoreCount();
    await openHistory();
    await rows.nth(1).click();
    await expect(versionText).not.toContainText("Replay marker.", {
      timeout: 20_000,
    });
    deskA.gate.holdAnswers("history:restore");
    await sendRestore();
    await expect
      .poll(() => restoreCount(), { timeout: 20_000 })
      .toBe(before + 1);
    await expect.poll(() => deskA.gate.heldAnswers("history:restore")).toBe(1);
    await expect(history).toBeVisible();
    deskA.gate.dropAnswers("history:restore");
    deskA.gate.hold("history:restore");
    await a.reload();
    await expect(editorA).toHaveAttribute("contenteditable", "false", {
      timeout: 20_000,
    });
    await expect
      .poll(() => deskA.gate.held("history:restore"), { timeout: 20_000 })
      .toBe(1);
    deskA.gate.release("history:restore");
    await expect(a.locator(".toast")).toContainText(
      "Restored the version from Today",
      { timeout: 20_000 },
    );
    await expect(editorA).toHaveAttribute("contenteditable", "true", {
      timeout: 20_000,
    });
    assert.equal(await restoreCount(), before + 1, "applied exactly once");
    assert.deepEqual(await recorded(a), []);
    await expect(editorA).not.toContainText("Replay marker.");
    // Editing resumes and saves.
    await typeAtEnd(a, editorA, " Resumed.");
    await saved(a);
    step(
      "review R3-1: a restore whose answer was lost is reconciled from the server's receipt, applied once",
    );
  }

  if (wanted("tab")) {
    // Review round 2, R2-4, the known gap (fundamentals, not changed): a
    // second tab of the same browser journals unsent typing, but this
    // window's guard learns nothing of it, Restore is allowed, and the other
    // tab's typing is lost.
    // A marker the restore will take away, saved from this tab first.
    await typeAtEnd(a, editorA, " Tab marker.");
    await saved(a);
    // The condition the reviewer found: the restoring tab receives nothing
    // while the other tab journals. The server refreshes a note's summary 2 s
    // after an edit, and that refresh re-reads this tab's cache (which would
    // then show the other tab's journal), so let it arrive first.
    await a.waitForTimeout(5_000);
    const a2 = await deskA.newPage();
    watch(a2, "Ada tab 2");
    await a2.goto(`${app}/notes/${noteId}`);
    const editorA2 = a2.getByRole("textbox", { name: "Note content" });
    await expect(editorA2).toHaveAttribute("contenteditable", "true", {
      timeout: 20_000,
    });
    await expect(editorA2).toContainText("Tab marker.", { timeout: 20_000 });
    deskA.gate.hold("notes:push");
    await typeAtEnd(a2, editorA2, " Other tab.");
    await expect(a2.locator(".save-status")).toHaveText("Saving…");
    await expect(
      a2.getByRole("button", { name: /^Recipe\b/ }).first(),
    ).toContainText("Unsaved changes", { timeout: 10_000 });
    await a.bringToFront();
    await openHistory();
    await rows.nth(1).click();
    await expect(restoreButton).toBeEnabled({ timeout: 20_000 });
    await expect(waiting).toHaveCount(0);
    await expect(recipeRow).not.toContainText("Unsaved changes");
    await restoreButton.click();
    await history.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(history).toBeHidden({ timeout: 20_000 });
    await expect(editorA2).not.toContainText("Tab marker.", {
      timeout: 20_000,
    });
    deskA.gate.release("notes:push");
    await a2.waitForTimeout(2_000);
    await expect(editorA2).not.toContainText("Other tab.");
    const newest = (await convex(a, "query", "history:list", { noteId }))
      .versions[0];
    const now = await convex(a, "query", "history:read", {
      noteId,
      revision: newest.revision,
    });
    assert.ok(!now.markdown.includes("Other tab."), "the other tab's word");
    await a2.close();
    step(
      "known gap, not changed (R2-4): another tab's unsent typing is invisible to this window's guard and lost on restore",
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
