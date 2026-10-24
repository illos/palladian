// Real-service proof of file notes and the PDF reader (plan 08, B4): a
// Convex development deployment (with FILES_WRITES_ENABLED on), the app, a
// local `wrangler dev` of the Worker for `/files`, and Chromium as a desktop
// and a phone (iPhone-sized, touch) of one person. Covers a file dropped on
// the desktop list and one chosen with the phone's Upload becoming file
// notes (made with notes.create, then uploaded after the title by the
// note's editor), the file-note view (a PDF in the reader, a picture fitted
// to the width), the list rows' type and size, the other device reading
// both through the Worker with its own token, the full-screen reader from a
// PDF chip, Cancel after the note exists, and files refused before any note
// is made. Prints no secrets. Disposable @example.test accounts only.
//
// As in attachments-e2e.mjs, dev does not trust this Worker's signing key,
// so the script answers `PUT /files/upload/*` in the browser as the Worker
// would: it places the bytes in the Worker's local bucket and calls
// `files:finalize` on dev as the file service. Everything else is real:
// notes.create, tickets, admission of the reference by the server, reads
// through the Worker and Convex's checks, pdf.js on the real bytes.
//
// CONVEX_DEPLOYMENT selects the development deployment (dev:…), NOTES_APP_URL
// the app (served with that deployment's VITE_NOTES_* URLs and
// NOTES_FILES_ORIGIN pointing its /files proxy at the Worker this script
// starts), NOTES_BACKEND_DIR the backend checkout, CONVEX_SITE_URL and
// CONVEX_CLOUD_URL the deployment's URLs; `dev-target.mjs` checks them all
// before anything is provisioned. FILE_NOTES_E2E_DEBUG logs page errors and
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
const { chromium, devices, expect } = require("@playwright/test");
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
const debug = !!process.env.FILE_NOTES_E2E_DEBUG;
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

/**
 * A small PDF, one page per entry, each line in Helvetica; generated here
 * (no private content). A random line makes each run's file its own.
 */
function pdf(pages) {
  const objects = [];
  const escape = (text) => text.replace(/[\\()]/g, (c) => "\\" + c);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pages
    .map((_, index) => `${4 + index * 2} 0 R`)
    .join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((lines, index) => {
    const content = `BT /F1 18 Tf 24 TL 72 740 Td ${lines
      .map((line) => `(${escape(line)}) '`)
      .join(" ")} ET`;
    objects[4 + index * 2] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`;
    objects[5 + index * 2] =
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(out, "latin1");
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out +=
    `xref\n0 ${objects.length}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((offset) => String(offset).padStart(10, "0") + " 00000 n \n")
      .join("") +
    `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
// Not a PDF: a PDF chip opens the reader (B4, file-notes-e2e.mjs), so the
// chip downloaded here is another kind of file.
const RUN = randomBytes(4).toString("hex");
const REPORT = pdf(
  Array.from({ length: 12 }, (_, index) => [
    `Page ${index + 1} heading`,
    `Run ${RUN}`,
    index === 7 ? "needle in a haystack" : "plain words",
  ]),
);
const SECOND = pdf([["Second PDF heading", `Run ${RUN}`]]);
const ARCHIVE = Buffer.from("PK\u0005\u0006 file notes e2e " + RUN + "\n");

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
  `file-notes-${name}-${randomBytes(4).toString("hex")}@example.test`;

/** A signing key nothing trusts, for the local Worker's required secret. */
async function disposableKey() {
  const { privateKey } = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await webcrypto.subtle.exportKey("jwk", privateKey);
  return JSON.stringify({ ...jwk, kid: "file-notes-e2e", alg: "ES256" });
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
  const dir = await mkdtemp(join(tmpdir(), "file-notes-e2e-"));
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

async function newContext(device = {}) {
  const context = await browser.newContext({
    ...device,
    acceptDownloads: true,
  });
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

/** One at a time, whichever device uploads: the local bucket takes one writer. */
let bucketQueue = Promise.resolve();

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
  await page.route("**/files/upload/*", async (route) => {
    const request = route.request();
    const objectId = objectOf(request.url());
    seen.push(objectId);
    if (held) await new Promise((resolve) => waiting.push(resolve));
    const turn = bucketQueue.then(() => answer(route, request, objectId));
    bucketQueue = turn.catch(() => undefined);
    await turn;
  });
  async function answer(route, request, objectId) {
    if (abandoned.has(objectId)) return;
    const ticket = secret(
      /^Bearer (.+)$/.exec(request.headers().authorization ?? "")?.[1] ?? "",
    );
    const bytes = request.postDataBuffer() ?? Buffer.alloc(0);
    const dir = await mkdtemp(join(tmpdir(), "file-notes-e2e-bytes-"));
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

/**
 * The attachment bytes the app keeps in this page's memory (object IDs),
 * read through the app's own module (the app runs from the dev server).
 */
function cachedObjects(page) {
  return page.evaluate(async () => {
    const url = "/src/attachment-cache.ts";
    const { attachmentCache } = await import(/* @vite-ignore */ url);
    return attachmentCache.objects();
  });
}

let stopWorker = async () => undefined;
process.on("unhandledRejection", (failure) => {
  console.error(
    `file-notes-e2e failed during "${current}": ${describeFailure(failure)}`,
  );
  void stopWorker().finally(() => process.exit(1));
});

/** The open note's ID, from the address. */
const openNoteId = (page) =>
  /^\/notes\/([A-Za-z0-9_-]+)$/.exec(new URL(page.url()).pathname)?.[1];

/** Drop files on the note list, as a drag from the desktop would. */
function dropOnList(page, files) {
  return page.evaluate(
    (files) => {
      const list = document.querySelector(".note-list");
      const data = new DataTransfer();
      for (const file of files)
        data.items.add(
          new File(
            [Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0))],
            file.name,
            { type: file.type },
          ),
        );
      for (const type of ["dragenter", "dragover", "drop"])
        list.dispatchEvent(
          new DragEvent(type, {
            dataTransfer: data,
            bubbles: true,
            cancelable: true,
          }),
        );
    },
    files.map((file) => ({ ...file, base64: file.buffer.toString("base64") })),
  );
}

/** The reader's page drawn from the PDF and its text in place. */
async function drawn(scope, number = 1, text = `Page ${number} heading`) {
  const view = scope.locator(".pdf-reader").first();
  const page = view.locator(`.pdf-page[data-page="${number}"]`);
  await expect(page.locator("canvas")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".pdf-text span").first()).toHaveText(text, {
    timeout: 30_000,
  });
  return view;
}

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
  const deskContext = await newContext();
  const desk = await deskContext.newPage();
  watch(desk, "desk");
  await desk.goto(setupLink(email));
  await desk.getByLabel("Your name").fill("Ada");
  await desk.getByLabel(/Choose a password/).fill(secretWord);
  await desk.getByLabel("Confirm password").fill(secretWord);
  await desk.getByRole("button", { name: "Create account" }).click();
  await desk.waitForURL(app + "/", { timeout: 20_000 });
  await connected(desk);
  await dismissPasskeyOffer(desk);
  assert.deepEqual(await convex(desk, "query", "files:capabilities", {}), {
    writes: true,
  });
  const { noteId: albumId } = await convex(
    desk,
    "mutation",
    "notes:createFromMarkdown",
    { markdown: "Album\n\nFirst line." },
  );
  await expect(desk.getByRole("button", { name: /^Album\b/ })).toBeVisible({
    timeout: 20_000,
  });
  const deskService = await fileService(desk, persist, issuer);
  // Wide screens have no Upload button; they take a drop on the list.
  await expect(
    desk.getByRole("button", { name: "Upload a file" }),
  ).toBeHidden();
  step("an account on dev with files on");

  begin("drop on the list");
  const deskReads = [];
  desk.on("request", (request) => {
    if (/\/files\/notes\//.test(request.url())) deskReads.push(request.url());
  });
  await dropOnList(desk, [
    { name: "report.pdf", type: "application/pdf", buffer: REPORT },
  ]);
  const deskEditor = desk.getByRole("textbox", { name: "Note content" });
  const large = deskEditor.locator(".note-file-large");
  await expect(large.locator(".file-name")).toHaveText("report.pdf", {
    timeout: 30_000,
  });
  await saved(desk);
  const reportNote = openNoteId(desk);
  assert.ok(reportNote, "the new note is open at its address");
  assert.deepEqual(await serverBlocks(desk, reportNote), [
    "report.pdf",
    "file:report.pdf",
  ]);
  await expect(deskEditor.locator("p").first()).toHaveText("report.pdf");
  const reportView = await drawn(desk);
  await expect(reportView.locator(".pdf-page-total")).toHaveText("/ 12");
  assert.equal(
    deskReads.length,
    0,
    "the reader shows the uploaded bytes without reading them back",
  );
  const reportObject = await large.getAttribute("data-object-id");
  assert.equal(
    inlineQuery(`(await ctx.db.get("${reportObject}"))?.state ?? null`),
    "ready",
  );
  const listed = await convex(desk, "query", "files:noteObjects", {
    noteId: reportNote,
  });
  assert.ok(
    listed.some((object) => object.objectId === reportObject),
    "the server records the file for the new note",
  );
  await shot(desk, "file-note-pdf");
  step(
    "a PDF dropped on the list becomes a note titled report.pdf with the file after the title; the reader shows it",
  );

  begin("list row");
  const reportRow = desk.getByRole("button", { name: /^report\.pdf/ });
  await expect(reportRow.locator(".row-file")).toHaveText(
    /^PDF · \d+(\.\d)? KB$/,
    { timeout: 20_000 },
  );
  await expect(reportRow.locator(".row-file-visual svg")).toBeVisible();
  step("its row shows a type icon and “PDF · size”");

  begin("phone upload");
  const phoneContext = await newContext(devices["iPhone 15 Plus"]);
  const phone = await phoneContext.newPage();
  watch(phone, "phone");
  const phoneReads = [];
  phone.on("request", (request) => {
    if (/\/files\/notes\//.test(request.url()))
      phoneReads.push({
        url: request.url(),
        authorization: request.headers().authorization ?? "",
      });
  });
  await phone.goto(app + "/");
  await phone.getByLabel("Email", { exact: true }).fill(email);
  await phone.getByLabel("Password", { exact: true }).fill(secretWord);
  await phone.getByRole("button", { name: "Sign in", exact: true }).click();
  await connected(phone);
  await dismissPasskeyOffer(phone);
  await fileService(phone, persist, issuer);
  const upload = phone.getByRole("button", { name: "Upload a file" });
  await expect(upload).toBeVisible({ timeout: 20_000 });
  const input = phone.locator(".file-note-input");
  assert.equal(await input.getAttribute("accept"), null);
  assert.equal(await input.getAttribute("capture"), null);
  assert.equal(await input.getAttribute("multiple"), null);
  const chooser = phone.waitForEvent("filechooser");
  await upload.click();
  await (
    await chooser
  ).setFiles({ name: "harbour.png", mimeType: "image/png", buffer: PHOTO });
  const phoneEditor = phone.getByRole("textbox", { name: "Note content" });
  const fitted = phoneEditor.locator(".note-image.is-file-note img");
  await expect(fitted).toBeVisible({ timeout: 30_000 });
  await saved(phone);
  const photoNote = openNoteId(phone);
  const photoBlocks = await serverBlocks(phone, photoNote);
  assert.equal(photoBlocks[0], "harbour.png");
  assert.match(photoBlocks[1], /^image:[a-z0-9]+$/);
  assert.equal(photoBlocks.length, 2);
  const photoObject = photoBlocks[1].slice("image:".length);
  // Fitted: the column's width, not the picture's 480 pixels or less.
  const column = (await phoneEditor.boundingBox()).width;
  const shown = (await fitted.boundingBox()).width;
  assert.ok(shown > column - 60, "the picture fills the column");
  await shot(phone, "file-note-photo");
  step(
    "the phone's Upload (no accept or capture) makes a note titled harbour.png with the picture fitted to the width",
  );

  begin("another device reads");
  await phone.getByRole("button", { name: "All notes" }).click();
  await phone.getByRole("button", { name: /^report\.pdf/ }).click();
  await drawn(phone);
  const read = phoneReads.find((entry) =>
    entry.url.endsWith("/" + reportObject),
  );
  assert.ok(read, "the PDF was read through /files");
  assert.equal(
    new URL(read.url).pathname,
    `/files/notes/${reportNote}/${reportObject}`,
  );
  assert.match(read.authorization, /^Bearer eyJ/);
  assert.ok(!/eyJ|token|ticket/i.test(read.url), "no token in the URL");
  assert.ok(
    !/eyJ[\w-]+\.[\w-]+/.test(await phone.content()),
    "no token in the page",
  );
  // Search in the real document.
  const phoneReader = phone.locator(".pdf-reader").first();
  await phoneReader.getByRole("button", { name: "Search in document" }).click();
  await phoneReader
    .getByRole("searchbox", { name: "Find in document" })
    .fill("needle");
  await expect(phoneReader.locator(".pdf-search-count")).toHaveText("1 of 1", {
    timeout: 20_000,
  });
  await expect(phoneReader.getByLabel("Page number")).toHaveValue("8");
  await shot(phone, "reader-search");
  step(
    "the phone reads the PDF through the Worker with its own token in a header; search finds page 8",
  );

  await desk.getByRole("button", { name: /^harbour\.png/ }).click();
  await expect(deskEditor.locator(".note-image.is-file-note img")).toBeVisible({
    timeout: 30_000,
  });
  assert.ok(
    deskReads.some((url) => url.endsWith("/" + photoObject)),
    "the desktop read the picture through /files",
  );
  await expect
    .poll(() => cachedObjects(desk), { timeout: 20_000 })
    .toContain(photoObject);
  // The list shows the picture it now holds once it next renders.
  await desk.getByRole("button", { name: /^report\.pdf/ }).click();
  if (debug)
    console.log(
      "[desk] cached",
      (await cachedObjects(desk)).includes(photoObject),
      "row",
      await desk
        .getByRole("button", { name: /^harbour\.png/ })
        .evaluate((row) => row.className + " " + row.innerHTML.slice(0, 300)),
    );
  const photoRow = desk.getByRole("button", { name: /^harbour\.png/ });
  await expect(photoRow.locator(".row-file-visual img")).toBeVisible({
    timeout: 20_000,
  });
  await expect(photoRow.locator(".row-file")).toHaveText(/^PNG/);
  await shot(desk, "list-rows");
  step(
    "the desktop shows the phone's picture; its row then shows the picture it holds, and “PNG”",
  );

  begin("full screen from a chip");
  const album = await openNote(desk, "Album");
  await caretAfter(desk, album, "First line.");
  await choose(desk, [
    { name: "second.pdf", mimeType: "application/pdf", buffer: SECOND },
  ]);
  const chip = album.locator(".note-file .file-chip");
  await expect(chip.locator(".file-name")).toHaveText("second.pdf", {
    timeout: 30_000,
  });
  await saved(desk);
  assert.deepEqual(await serverBlocks(desk, albumId), [
    "Album",
    "First line.",
    "file:second.pdf",
  ]);
  await chip.click();
  await chip.click();
  const dialog = desk.getByRole("dialog", { name: "PDF: second.pdf" });
  await expect(dialog).toBeVisible();
  await drawn(dialog, 1, "Second PDF heading");
  await shot(desk, "full-screen");
  await desk.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  step("an inline PDF chip opens the reader full screen; Escape closes it");

  begin("cancel after the note exists");
  deskService.hold();
  await dropOnList(desk, [
    { name: "big.zip", type: "application/zip", buffer: ARCHIVE },
  ]);
  const widget = desk.getByRole("group", { name: "Upload of big.zip" });
  await expect(widget).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => deskService.waiting(), { timeout: 30_000 }).toBe(1);
  const cancelled = deskService.seen.at(-1);
  const bigNote = openNoteId(desk);
  await widget.getByRole("button", { name: "Cancel" }).click();
  await expect(widget).toHaveCount(0);
  deskService.release();
  await expect
    .poll(
      () => inlineQuery(`(await ctx.db.get("${cancelled}"))?.state ?? null`),
      { timeout: 20_000 },
    )
    .toBe("failed");
  assert.deepEqual(await serverBlocks(desk, bigNote), ["big.zip"]);
  step(
    "Cancel after the note exists: the upload's object fails on the server, and the note stays with its title",
  );

  begin("refused before a note");
  const before = (await convex(desk, "query", "library:recent", { limit: 100 }))
    .notes.length;
  await dropOnList(desk, [
    { name: "empty.txt", type: "text/plain", buffer: Buffer.alloc(0) },
  ]);
  await expect(desk.locator(".toast").last()).toHaveText(
    /This file is empty\./,
  );
  await dropOnList(desk, [
    { name: "a.txt", type: "text/plain", buffer: Buffer.from("a") },
    { name: "b.txt", type: "text/plain", buffer: Buffer.from("b") },
  ]);
  await expect(desk.locator(".toast").last()).toHaveText(
    /Drop one file at a time to make a file note\./,
  );
  await desk.waitForTimeout(1_000);
  assert.equal(
    (await convex(desk, "query", "library:recent", { limit: 100 })).notes
      .length,
    before,
    "no note was made",
  );
  step(
    "an empty file, or several at once, are refused before any note is made",
  );

  await deskContext.close();
  await phoneContext.close();
  console.log("file-notes-e2e: PASS");
} catch (failure) {
  console.error(
    `file-notes-e2e failed during "${current}": ${describeFailure(failure)}`,
  );
  process.exitCode = 1;
} finally {
  await browser.close();
  await stopWorker();
}
