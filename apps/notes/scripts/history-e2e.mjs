// Real-service proof of note history (plan 08, A4): a Convex development
// deployment + the app + Chromium on a desktop and an emulated iPhone. Covers
// the version list (who, what, when) after edits by two people, reading an old
// version and comparing it with the previous and the current one, paging,
// restoring while another signed-in person types in the note (both converge;
// the restored text and their later typing survive), and that a read-only
// collaborator, or an editor whose access drops to read, never reaches
// History. Prints no secrets. Disposable @example.test accounts only.
//
// CONVEX_DEPLOYMENT selects the development deployment (dev:…), NOTES_APP_URL
// the app (served with that deployment's VITE_NOTES_* URLs), NOTES_BACKEND_DIR
// the backend checkout, CONVEX_SITE_URL and CONVEX_CLOUD_URL the deployment's
// URLs. SCREENSHOT_DIR, if set, receives pictures of the panel.
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
if (
  process.env.CONVEX_PROD ||
  !/^dev:/.test(process.env.CONVEX_DEPLOYMENT ?? "")
)
  throw new Error(
    "Run against a development deployment (CONVEX_DEPLOYMENT=dev:…).",
  );
const site = process.env.CONVEX_SITE_URL;
const cloud = process.env.CONVEX_CLOUD_URL;
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

const secret = () => randomBytes(18).toString("base64url");
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

async function newContext(options = {}) {
  const context = await browser.newContext(options);
  await context.addInitScript(
    ({ site, cloud }) => {
      window.__palladianTest = { site, cloud };
    },
    { site, cloud },
  );
  return context;
}

/** Creates an account from an invitation or setup link; returns its page. */
async function acceptLink(context, link, name, password) {
  const page = await context.newPage();
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

const browser = await chromium.launch({ headless: true });
try {
  // Ada owns the note; Cy may edit it; Bo may only read it.
  const adaEmail = address("ada");
  const adaPassword = secret();
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
  const cyLink = `${app}/invite#${await invite("edit")}`;
  const boLink = `${app}/invite#${await invite("read")}`;
  const deskC = await newContext();
  const c = await acceptLink(deskC, cyLink, "Cy", secret());
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
  step("edits by Ada, then Cy, then Ada again");

  const history = a.getByRole("dialog", { name: "History of Recipe" });
  await a.getByRole("button", { name: "Note history" }).click();
  await expect(history).toBeVisible();
  const rows = history.locator(".history-row");
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
  step("History lists who, what and when for each version, newest first");

  // Cy's version, read-only, then compared.
  await rows.nth(1).click();
  const versionText = history.getByRole("document", { name: "Version text" });
  await expect(versionText).toContainText("Cy was here.", { timeout: 20_000 });
  await expect(versionText).not.toContainText("Ada's second line.");
  await expect(versionText.locator("[contenteditable]")).toHaveCount(0);
  const changes = history.getByRole("document", { name: "Changes" });
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
  await expect(history.getByText(/compared with an empty note/)).toBeVisible();
  await expect(changes.locator("ins")).toContainText(["Recipe"]);
  // The newest version is the note as it is now; it cannot be restored.
  await rows.first().click();
  await expect(
    history.getByText("This is the note as it is now."),
  ).toBeVisible();
  await expect(
    history.getByRole("button", { name: "Restore this version…" }),
  ).toHaveCount(0);
  step(
    "an old version reads read-only, and compares with the previous and current",
  );

  // Restore Ada's first edit while Cy keeps typing.
  await rows.nth(2).click();
  await expect(versionText).toContainText("Ada's first edit.");
  await expect(versionText).not.toContainText("Cy was here.");
  let typing = true;
  const ticker = (async () => {
    let n = 0;
    while (typing) {
      await typeAtEnd(c, editorC, ` tick${++n}`);
      await c.waitForTimeout(250);
    }
    return n;
  })();
  await c.waitForTimeout(800);
  const conflictNotice = history.getByText(
    /The note changed before the restore/,
  );
  let conflicts = 0;
  for (;;) {
    await history
      .getByRole("button", { name: "Restore this version…" })
      .click();
    await history.getByRole("button", { name: "Restore", exact: true }).click();
    let outcome = "pending";
    await expect
      .poll(
        async () => {
          if (!(await history.isVisible())) outcome = "restored";
          else if (await conflictNotice.isVisible()) outcome = "conflict";
          return outcome;
        },
        { timeout: 20_000 },
      )
      .not.toBe("pending");
    if (outcome === "restored") break;
    conflicts++;
    assert.ok(conflicts < 20, "a restore got through between Cy's edits");
  }
  await expect(a.locator(".toast")).toContainText(
    "Restored the version from Today",
  );
  // Cy's editor receives the restore through collaboration.
  await expect(editorC).not.toContainText("Ada's second line.", {
    timeout: 20_000,
  });
  await expect(editorC).not.toContainText("Cy was here.");
  typing = false;
  const ticks = await ticker;
  await typeAtEnd(c, editorC, " After restore.");
  await saved(c);
  await expect(editorA).toContainText("After restore.", { timeout: 20_000 });
  await expect
    .poll(
      async () => (await editorA.innerText()) === (await editorC.innerText()),
      {
        timeout: 20_000,
      },
    )
    .toBe(true);
  const finalText = await editorA.innerText();
  for (const kept of [
    "Recipe",
    "First line. Ada's first edit.",
    "After restore.",
  ])
    assert.ok(finalText.includes(kept), `kept: ${kept}`);
  for (const gone of ["Cy was here.", "Ada's second line."])
    assert.ok(!finalText.includes(gone), `restored away: ${gone}`);
  const after = await convex(a, "query", "history:list", { noteId });
  const restoreAt = after.versions.findIndex((v) => v.kind === "restore");
  assert.ok(restoreAt > 0, "Cy's later typing is a version after the restore");
  assert.equal(after.versions[restoreAt].actorName, "Ada");
  assert.equal(after.versions[0].actorName, "Cy");
  const server = await convex(a, "query", "history:read", {
    noteId,
    revision: after.versions[0].revision,
  });
  assert.ok(server.markdown.includes("After restore."));
  assert.ok(server.markdown.includes("First line. Ada's first edit."));
  assert.ok(!server.markdown.includes("Ada's second line."));
  step(
    `restored while Cy typed (${ticks} bursts, ${conflicts} conflict${conflicts === 1 ? "" : "s"} retried); both converge, Cy's later typing kept`,
  );

  // Paging: more versions than one page holds.
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
  await pagingHistory.getByRole("button", { name: "Done" }).click();
  await expect(pagingHistory).toBeHidden();
  step("33 versions page as 30, then Show older versions shows the rest");

  // Bo can only read: no History anywhere, and the server refuses it.
  const deskB = await newContext();
  const b = await acceptLink(deskB, boLink, "Bo", secret());
  await openNote(b, "Recipe", false);
  await expect(b.getByRole("button", { name: "Note info" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(b.getByRole("button", { name: "Note history" })).toHaveCount(0);
  await b.getByRole("button", { name: "More actions" }).click();
  const bMenu = b.getByRole("dialog", { name: "Actions for Recipe" });
  await expect(bMenu.getByRole("menuitem")).toHaveText([
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
  await expect(c.getByRole("button", { name: "Note history" })).toHaveCount(0, {
    timeout: 20_000,
  });
  await assert.rejects(
    convex(c, "query", "history:list", { noteId }),
    /denied/,
  );
  step("Cy's open History closes when his access drops to read");

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
  const phoneHistory = phone.getByRole("dialog", { name: "History of Recipe" });
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
  await shot(phone, "phone-history-diff");
  await phoneHistory.getByRole("button", { name: "Versions" }).click();
  await expect(
    phoneHistory.getByRole("region", { name: "Versions" }),
  ).toBeVisible();
  await phoneHistory.getByRole("button", { name: "Done" }).click();
  await expect(phoneHistory).toBeHidden();
  step("phone: History from the … sheet fills the screen, one step at a time");
  console.log("All history checks passed.");
} catch (failure) {
  // A picture of each page at the failure, for the person debugging it.
  for (const [i, open] of browser
    .contexts()
    .flatMap((context) => context.pages())
    .entries())
    await open
      .screenshot({ path: `/tmp/history-e2e-failure-${i}.png` })
      .catch(() => undefined);
  throw failure;
} finally {
  await browser.close();
}
