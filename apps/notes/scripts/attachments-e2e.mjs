// Real-service proof of inline attachments (plan 08, B3): a Convex
// development deployment (with FILES_WRITES_ENABLED on), the app, a local
// `wrangler dev` of the Worker for `/files`, and Chromium as two devices of
// one person. Covers "+ File", an upload the Worker refuses and its Retry,
// insertion where the note has moved the upload (typing on this device and
// another), a file chip, reading pictures and files through the Worker with
// the app's token on another device, the lightbox, resizing, Cancel,
// closing a note mid-upload, the "Attachment unavailable" placeholder, and
// the byte cache emptied at sign-out. Prints no secrets. Disposable
// @example.test accounts only.
//
// The dev deployment does not trust this Worker's signing key (its private
// key is not available locally; see the B1 report), so the Worker cannot
// finalize uploads itself: it answers 503 and the app offers Retry. From
// then on the script answers `PUT /files/upload/*` in the browser as the
// Worker would: it places the bytes in the Worker's local bucket
// (`wrangler r2 object put --local`) and calls `files:finalize` on dev as
// the file service (`npx convex run --identity`), as files-e2e.mjs does with
// SERVICE_KEY_TRUSTED=0. Everything else is real: tickets, admission of the
// reference by the server, reads through the Worker and Convex's checks.
//
// CONVEX_DEPLOYMENT selects the development deployment (dev:…), NOTES_APP_URL
// the app (served with that deployment's VITE_NOTES_* URLs and
// NOTES_FILES_ORIGIN pointing its /files proxy at the Worker this script
// starts), NOTES_BACKEND_DIR the backend checkout, CONVEX_SITE_URL and
// CONVEX_CLOUD_URL the deployment's URLs; `dev-target.mjs` checks them all
// before anything is provisioned. ATTACHMENTS_E2E_DEBUG logs page errors and
// the Worker's output, redacted. SCREENSHOT_DIR, if set, receives pictures.
import assert from "node:assert/strict";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { crc32, deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { assertDevTarget } from "./dev-target.mjs";
import { describeFailure, redact, secret } from "./redact.mjs";

const require = createRequire(new URL("../package.json", import.meta.url));
const { chromium, expect } = require("@playwright/test");
const run = promisify(execFile);
const backend =
  process.env.NOTES_BACKEND_DIR ??
  fileURLToPath(new URL("../../notes-backend", import.meta.url));
const edge = fileURLToPath(new URL("../../notes-edge", import.meta.url));
const assets = fileURLToPath(new URL("../dist", import.meta.url));
const app = process.env.NOTES_APP_URL ?? "http://localhost:5178";
const worker = new URL(
  process.env.NOTES_FILES_ORIGIN ?? "http://localhost:8787",
);
const debug = !!process.env.ATTACHMENTS_E2E_DEBUG;
let current = "start";
const begin = (name) => {
  current = name;
};
const step = (message) => console.log("✓ " + message);
const shots = process.env.SCREENSHOT_DIR;
const shot = (page, name) =>
  shots ? page.screenshot({ path: `${shots}/${name}.png` }) : undefined;
let site = "";
let cloud = "";

/** A PNG of the given size. */
function png(width, height) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = y * row + 1 + x * 3;
      raw[at] = 59;
      raw[at + 1] = 91 + ((x + y) % 60);
      raw[at + 2] = 219;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const PHOTO = png(480, 320);
const REPORT = Buffer.from(
  "%PDF-1.7\n% attachments e2e " + randomBytes(8).toString("hex") + "\n",
);

function convexCli(args, extra = []) {
  const result = spawnSync("npx", ["convex", ...args, ...extra], {
    cwd: backend,
    encoding: "utf8",
    maxBuffer: 1 << 22,
  });
  assert.equal(result.status, 0, `convex ${args[0]} ${args[1] ?? ""} ran`);
  return result.stdout;
}
/** The deployment's issuer for the Worker's service tokens (not secret). */
const serviceIssuer = () =>
  convexCli(["env", "get", "AGENT_JWT_ISSUER"]).trim();

/** A read-only inline query against the deployment (states and counts only). */
function inlineQuery(expression) {
  const out = convexCli(["run", "--inline-query", `return ${expression};`]);
  return JSON.parse(out.slice(out.search(/[[{"0-9tfn]/)));
}

function setupLink(email) {
  const out = convexCli([
    "run",
    "provision:setupOwner",
    JSON.stringify({ email }),
  ]);
  const token = secret(JSON.parse(out.slice(out.indexOf("{"))).token);
  return `${app}/invite#${token}`;
}
const password = () => secret(randomBytes(18).toString("base64url"));
const address = (name) =>
  `attachments-${name}-${randomBytes(4).toString("hex")}@example.test`;

/** A signing key nothing trusts, for the local Worker's required secret. */
async function disposableKey() {
  const { privateKey } = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await webcrypto.subtle.exportKey("jwk", privateKey);
  return JSON.stringify({ ...jwk, kid: "attachments-e2e", alg: "ES256" });
}

/**
 * `wrangler dev` of the Worker on NOTES_FILES_ORIGIN's port, reading Convex
 * dev, with its own local bucket. Stopped (its whole process group) at the
 * end.
 */
async function startWorker() {
  // Another Worker on the port would serve another bucket.
  const busy = await fetch(worker.origin).then(
    () => true,
    () => false,
  );
  if (busy) throw new Error(`Something already listens on ${worker.origin}.`);
  const dir = await mkdtemp(join(tmpdir(), "attachments-e2e-"));
  const persist = join(dir, "state");
  const env = join(dir, "worker.env");
  await writeFile(
    env,
    [
      `PUBLIC_ORIGIN=${worker.origin}`,
      `AGENT_JWT_ISSUER=${worker.origin}`,
      `CONVEX_URL=${cloud}`,
      `AGENT_JWT_PRIVATE_KEY='${await disposableKey()}'`,
    ].join("\n") + "\n",
    { mode: 0o600 },
  );
  // The Worker serves the app's built files too; /files needs none of them.
  const madeAssets = !existsSync(assets);
  if (madeAssets) await mkdir(assets, { recursive: true });
  const child = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "--port",
      worker.port,
      "--ip",
      "127.0.0.1",
      "--local-upstream",
      `localhost:${worker.port}`,
      "--upstream-protocol",
      "http",
      "--persist-to",
      persist,
      "--env-file",
      env,
    ],
    { cwd: edge, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const output = (data) => {
    if (debug)
      for (const line of String(data).split("\n"))
        if (line.trim()) console.log(`[worker] ${redact(line).slice(0, 200)}`);
  };
  child.stdout.on("data", output);
  child.stderr.on("data", output);
  const stop = async () => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
    await rm(dir, { recursive: true, force: true });
    if (madeAssets) await rm(assets, { recursive: true, force: true });
  };
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      const response = await fetch(
        `${worker.origin}/files/notes/k0000000000000000/k0000000000000000`,
      );
      if (response.status === 401) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error("The local Worker did not start.");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { persist, stop };
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
async function saved(page) {
  await expect(page.locator(".save-status")).toHaveText("Saved", {
    timeout: 20_000,
  });
}

function watch(page, name) {
  if (!debug) return;
  const log = (text) => console.log(`[${name}] ${redact(text).slice(0, 300)}`);
  page.on("pageerror", (error) => log(`page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      log(`console ${message.type()}: ${message.text()}`);
  });
}

async function newContext() {
  const context = await browser.newContext({ acceptDownloads: true });
  await context.addInitScript(
    ({ site, cloud }) => {
      window.__palladianTest = { site, cloud };
    },
    { site, cloud },
  );
  return context;
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

/** The note's top-level blocks on the server: text, `image:<id>` or `file:<name>`. */
async function serverBlocks(page, noteId) {
  const content = await convex(page, "query", "notes:content", { noteId });
  const doc = JSON.parse(content.doc);
  return doc.content.map((node) =>
    node.type === "image"
      ? `image:${String(node.attrs.src).replace(/^attachment:/, "")}`
      : node.type === "file"
        ? `file:${node.attrs.name}`
        : (node.content ?? []).map((child) => child.text ?? "").join(""),
  );
}
async function serverImage(page, noteId, objectId) {
  const doc = JSON.parse(
    (await convex(page, "query", "notes:content", { noteId })).doc,
  );
  return doc.content.find(
    (node) =>
      node.type === "image" && node.attrs.src === `attachment:${objectId}`,
  );
}

async function openNote(page, title) {
  await page
    .getByRole("button", { name: new RegExp(`^${title}\\b`) })
    .first()
    .click();
  const editor = page.getByRole("textbox", { name: "Note content" });
  await expect(editor).toHaveAttribute("contenteditable", "true", {
    timeout: 20_000,
  });
  return editor;
}

/** Click a line, put the caret at its end, and let the editor read it. */
async function caretAfter(page, editor, text) {
  await editor.getByText(text, { exact: true }).click();
  await page.keyboard.press("End");
  await page.waitForTimeout(150);
}

async function choose(page, files) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add file" }).click();
  await (await chooser).setFiles(files);
}

const objectOf = (url) => new URL(url).pathname.split("/").pop();

/**
 * Answer the app's uploads in the browser as the Worker would (see the top
 * of this file). `hold()` keeps them waiting until `release()`.
 */
async function fileService(page, persist, issuer) {
  let held = false;
  const waiting = [];
  const seen = [];
  /** Uploads the app gave up on (Cancel, a closed note): nothing to answer. */
  const abandoned = new Set();
  page.on("requestfailed", (request) => {
    if (/\/files\/upload\//.test(request.url()))
      abandoned.add(objectOf(request.url()));
  });
  // One at a time: the local bucket takes one writer.
  let queue = Promise.resolve();
  await page.route("**/files/upload/*", async (route) => {
    const request = route.request();
    const objectId = objectOf(request.url());
    seen.push(objectId);
    if (held) await new Promise((resolve) => waiting.push(resolve));
    const turn = queue.then(() => answer(route, request, objectId));
    queue = turn.catch(() => undefined);
    await turn;
  });
  async function answer(route, request, objectId) {
    if (abandoned.has(objectId)) return;
    const ticket = secret(
      /^Bearer (.+)$/.exec(request.headers().authorization ?? "")?.[1] ?? "",
    );
    const bytes = request.postDataBuffer() ?? Buffer.alloc(0);
    const dir = await mkdtemp(join(tmpdir(), "attachments-e2e-bytes-"));
    try {
      await writeFile(join(dir, "bytes"), bytes);
      await run(
        "npx",
        [
          "wrangler",
          "r2",
          "object",
          "put",
          `palladian-notes-files/objects/${objectId}`,
          "--file",
          join(dir, "bytes"),
          "--local",
          "--persist-to",
          persist,
        ],
        { cwd: edge },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const out = convexCli(
      [
        "run",
        "files:finalize",
        JSON.stringify({
          objectId,
          ticket,
          size: bytes.length,
          sha256: sha256(bytes),
        }),
      ],
      ["--identity", JSON.stringify({ issuer, subject: "service:files" })],
    );
    const done = JSON.parse(out.slice(out.indexOf("{")));
    await route
      .fulfill({
        status: done.status === "ready" ? 200 : 410,
        contentType: "application/json",
        body: JSON.stringify(
          done.status === "ready"
            ? {
                object_id: objectId,
                state: "ready",
                size: bytes.length,
                sha256: sha256(bytes),
              }
            : { error: "expired" },
        ),
      })
      .catch(() => undefined);
  }
  return {
    seen,
    waiting: () => waiting.length,
    hold() {
      held = true;
    },
    release() {
      held = false;
      for (const resolve of waiting.splice(0)) resolve();
    },
  };
}

/** The attachment bytes the app keeps in this page's IndexedDB. */
function cachedObjects(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("palladian-attachments");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("entries")) {
            db.close();
            resolve([]);
            return;
          }
          const request = db
            .transaction("entries")
            .objectStore("entries")
            .getAll();
          request.onsuccess = () => {
            db.close();
            resolve(request.result.map((entry) => entry.objectId));
          };
          request.onerror = () => reject(request.error);
        };
      }),
  );
}

let stopWorker = async () => undefined;
process.on("unhandledRejection", (failure) => {
  console.error(
    `attachments-e2e failed during "${current}": ${describeFailure(failure)}`,
  );
  void stopWorker().finally(() => process.exit(1));
});

const browser = await chromium.launch({ headless: true });
try {
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

  begin("worker");
  const issuer = serviceIssuer();
  const { persist, stop } = await startWorker();
  stopWorker = stop;
  const proxied = await fetch(
    `${app}/files/notes/k0000000000000000/k0000000000000000`,
  );
  assert.equal(proxied.status, 401, "the app's /files reaches the Worker");
  step("a local Worker serves /files for the app (401 without a token)");

  begin("setup");
  const email = address("ada");
  const secretWord = password();
  const deskA = await newContext();
  const a = await deskA.newPage();
  watch(a, "A");
  await a.goto(setupLink(email));
  await a.getByLabel("Your name").fill("Ada");
  await a.getByLabel(/Choose a password/).fill(secretWord);
  await a.getByLabel("Confirm password").fill(secretWord);
  await a.getByRole("button", { name: "Create account" }).click();
  await a.waitForURL(app + "/", { timeout: 20_000 });
  await connected(a);
  await dismissPasskeyOffer(a);
  assert.deepEqual(await convex(a, "query", "files:capabilities", {}), {
    writes: true,
  });
  const { noteId } = await convex(a, "mutation", "notes:createFromMarkdown", {
    markdown: "Album\n\nFirst line.\n\nSecond line.",
  });
  await convex(a, "mutation", "notes:createFromMarkdown", {
    markdown: "Elsewhere\n\nAnother note.",
  });
  const editorA = await openNote(a, "Album");
  await expect(a.getByRole("button", { name: "Add file" })).toBeVisible({
    timeout: 20_000,
  });
  step("an account on dev with files on; + File is offered in its note");

  begin("refused upload");
  const workerPuts = [];
  a.on("request", (request) => {
    if (/\/files\/upload\//.test(request.url()))
      workerPuts.push(objectOf(request.url()));
  });
  await caretAfter(a, editorA, "First line.");
  await choose(a, [
    { name: "harbour.png", mimeType: "image/png", buffer: PHOTO },
  ]);
  const harbour = a.getByRole("group", { name: "Upload of harbour.png" });
  await expect(harbour.getByRole("status")).toHaveText(
    "The upload failed. Check the connection and retry.",
    { timeout: 30_000 },
  );
  await expect(harbour.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(harbour.getByRole("button", { name: "Remove" })).toBeVisible();
  assert.deepEqual(await serverBlocks(a, noteId), [
    "Album",
    "First line.",
    "Second line.",
  ]);
  const refusedObject = workerPuts[0];
  assert.ok(refusedObject, "the upload reached the Worker");
  assert.equal(
    inlineQuery(`(await ctx.db.get("${refusedObject}"))?.state ?? null`),
    "pending",
  );
  await shot(a, "failed-upload");
  step(
    "the Worker refuses to finalize (dev does not trust its key): the upload shows Retry and Remove; the note is unchanged",
  );

  begin("retry");
  const service = await fileService(a, persist, issuer);
  await harbour.getByRole("button", { name: "Retry" }).click();
  await expect(harbour).toHaveCount(0, { timeout: 30_000 });
  assert.deepEqual(service.seen, [refusedObject], "Retry sent the same object");
  const photo = refusedObject;
  await saved(a);
  assert.deepEqual(await serverBlocks(a, noteId), [
    "Album",
    "First line.",
    `image:${photo}`,
    "Second line.",
  ]);
  const listed = await convex(a, "query", "files:noteObjects", { noteId });
  assert.ok(
    listed.some(
      (object) => object.objectId === photo && object.state === "ready",
    ),
    "the server lists the object for the note",
  );
  await expect(editorA.locator(".note-image img")).toBeVisible();
  step(
    "Retry finishes the same object; the picture lands after the caret's line and the server records it for the note",
  );

  begin("file chip");
  await caretAfter(a, editorA, "Second line.");
  await choose(a, [
    { name: "report.pdf", mimeType: "application/pdf", buffer: REPORT },
  ]);
  const chip = editorA.locator("[data-object-id]");
  await expect(chip.locator(".file-name")).toHaveText("report.pdf", {
    timeout: 30_000,
  });
  await expect(chip.locator(".file-meta")).toHaveText(/^PDF · \d+ B$/);
  await saved(a);
  assert.deepEqual((await serverBlocks(a, noteId)).slice(-1), [
    "file:report.pdf",
  ]);
  const reportObject = await chip.getAttribute("data-object-id");
  step("a PDF becomes a file chip with its type and size");

  begin("another device");
  const deskB = await newContext();
  const b = await deskB.newPage();
  watch(b, "B");
  const reads = [];
  b.on("request", (request) => {
    if (/\/files\/notes\//.test(request.url()))
      reads.push({
        url: request.url(),
        authorization: request.headers().authorization ?? "",
      });
  });
  await b.goto(app + "/");
  await b.getByLabel("Email", { exact: true }).fill(email);
  await b.getByLabel("Password", { exact: true }).fill(secretWord);
  await b.getByRole("button", { name: "Sign in", exact: true }).click();
  await connected(b);
  await dismissPasskeyOffer(b);
  const editorB = await openNote(b, "Album");
  const pictureB = editorB.locator(".note-image img");
  await expect(pictureB).toBeVisible({ timeout: 30_000 });
  assert.equal(await pictureB.evaluate((img) => img.naturalWidth), 480);
  assert.match(await pictureB.getAttribute("src"), /^blob:/);
  const read = reads.find((entry) => entry.url.endsWith("/" + photo));
  assert.ok(read, "the picture was read through /files");
  assert.equal(new URL(read.url).pathname, `/files/notes/${noteId}/${photo}`);
  assert.match(read.authorization, /^Bearer eyJ/);
  assert.ok(!/eyJ|token|ticket/i.test(read.url), "no token in the URL");
  // The page holds no token or signed URL.
  assert.ok(
    !/eyJ[\w-]+\.[\w-]+/.test(await b.content()),
    "no token in the page",
  );
  step(
    "another device reads the picture through the Worker with its own token in a header",
  );

  const chipB = editorB.locator("[data-object-id] .file-chip");
  await chipB.click();
  const download = b.waitForEvent("download");
  await chipB.click();
  const file = await download;
  assert.equal(file.suggestedFilename(), "report.pdf");
  assert.ok(
    (await readFile(await file.path())).equals(REPORT),
    "downloaded bytes match",
  );
  step("tapping the selected chip downloads the file's exact bytes");

  const lightbox = b.getByRole("dialog", { name: "Picture: harbour.png" });
  await pictureB.click();
  await pictureB.click();
  await expect(lightbox).toBeVisible();
  await shot(b, "lightbox");
  await b.keyboard.press("Escape");
  await expect(lightbox).toBeHidden();
  step("the lightbox opens from the selected picture and closes with Escape");
  await expect
    .poll(() => cachedObjects(b))
    .toEqual(expect.arrayContaining([photo, reportObject]));
  step("the second device keeps the bytes it showed in its attachment cache");

  begin("resize");
  const pictureA = editorA.locator(".note-image img");
  await pictureA.click();
  const grip = editorA.locator(".image-grip");
  await expect(grip).toBeVisible();
  const box = await grip.boundingBox();
  const start = (await pictureA.boundingBox()).width;
  await a.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await a.mouse.down();
  for (let i = 1; i <= 8; i++)
    await a.mouse.move(box.x + box.width / 2 - i * 20, box.y + box.height / 2);
  await a.mouse.up();
  const width = Math.round(start - 160);
  await saved(a);
  await expect
    .poll(async () => (await serverImage(a, noteId, photo))?.attrs.width)
    .toBe(width);
  await expect(pictureB).toHaveAttribute("width", String(width), {
    timeout: 20_000,
  });
  step(`dragging the corner saves width ${width}; the other device shows it`);

  begin("concurrent edits");
  service.hold();
  await caretAfter(a, editorA, "Second line.");
  await choose(a, [
    { name: "second.png", mimeType: "image/png", buffer: png(64, 48) },
  ]);
  await expect.poll(() => service.waiting(), { timeout: 30_000 }).toBe(1);
  // The other device adds a line under the title; this one types below.
  await editorB.getByText("Album", { exact: true }).click();
  await b.keyboard.press("End");
  await b.waitForTimeout(150);
  await b.keyboard.press("Enter");
  await b.keyboard.type("From the other device.");
  await saved(b);
  await expect(editorA).toContainText("From the other device.", {
    timeout: 20_000,
  });
  await caretAfter(a, editorA, "Second line.");
  await a.keyboard.type(" Typed.");
  service.release();
  await expect(a.locator(".upload-widget")).toHaveCount(0, { timeout: 30_000 });
  await saved(a);
  const second = service.seen.at(-1);
  assert.deepEqual(await serverBlocks(a, noteId), [
    "Album",
    "From the other device.",
    "First line.",
    `image:${photo}`,
    "Second line. Typed.",
    `image:${second}`,
    "file:report.pdf",
  ]);
  step(
    "an upload lands where the note has moved it: another device's line above, typing in its line",
  );

  begin("cancel");
  service.hold();
  await caretAfter(a, editorA, "First line.");
  await choose(a, [
    { name: "cancelled.png", mimeType: "image/png", buffer: png(20, 20) },
  ]);
  await expect.poll(() => service.waiting(), { timeout: 30_000 }).toBe(1);
  const cancelled = service.seen.at(-1);
  await a
    .getByRole("group", { name: "Upload of cancelled.png" })
    .getByRole("button", { name: "Cancel" })
    .click();
  await expect
    .poll(
      () => inlineQuery(`(await ctx.db.get("${cancelled}"))?.state ?? null`),
      {
        timeout: 20_000,
      },
    )
    .toBe("failed");
  step("Cancel asks the server to drop the upload (its object fails)");

  begin("closing mid-upload");
  await choose(a, [
    { name: "abandoned.png", mimeType: "image/png", buffer: png(24, 24) },
  ]);
  await expect.poll(() => service.waiting(), { timeout: 30_000 }).toBe(2);
  const abandoned = service.seen.at(-1);
  await openNote(a, "Elsewhere");
  await expect
    .poll(
      () => inlineQuery(`(await ctx.db.get("${abandoned}"))?.state ?? null`),
      {
        timeout: 20_000,
      },
    )
    .toBe("failed");
  service.release();
  await openNote(a, "Album");
  await a.waitForTimeout(500);
  await expect(a.locator(".upload-widget")).toHaveCount(0);
  assert.ok(
    !(await serverBlocks(a, noteId)).some((block) =>
      [`image:${cancelled}`, `image:${abandoned}`].includes(block),
    ),
    "neither cancelled upload is in the note",
  );
  step("closing the note mid-upload cancels it; nothing lands later");

  begin("unavailable");
  const ghost = "k" + randomBytes(16).toString("hex").slice(0, 31);
  await convex(a, "mutation", "notes:edit", {
    noteId,
    edits: [{ type: "append", markdown: `![ghost](attachment:${ghost})` }],
  });
  const placeholderB = editorB.locator(
    `.note-image[data-src="attachment:${ghost}"] .attachment-placeholder`,
  );
  await expect(placeholderB).toHaveText("Attachment unavailable", {
    timeout: 30_000,
  });
  await shot(b, "unavailable");
  step("a reference that grants nothing shows Attachment unavailable");

  begin("sign-out");
  await b.locator(".connection-status").click();
  await b.getByRole("button", { name: "Sign out…" }).click();
  await b.getByRole("button", { name: "Sign out of this device" }).click();
  await expect.poll(() => cachedObjects(b), { timeout: 20_000 }).toEqual([]);
  assert.ok(
    (await cachedObjects(a)).includes(photo),
    "the first device keeps its own",
  );
  step("signing out empties that device's attachment cache");

  await deskA.close();
  await deskB.close();
  console.log("attachments-e2e: PASS");
} catch (failure) {
  console.error(
    `attachments-e2e failed during "${current}": ${describeFailure(failure)}`,
  );
  process.exitCode = 1;
} finally {
  await browser.close();
  await stopWorker();
}
