import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { crc32, deflateSync } from "node:zlib";
import {
  expect,
  test,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";

/**
 * Inline attachments (plan 08, B3) against the test-only harness
 * (harness/attachments.html): the real note editor, bound like a live note,
 * with a stand-in for the server's file functions (`files.createUpload`,
 * `cancelUpload`, `noteObjects` and the token). The Worker's `/files/*`
 * routes are answered here with Playwright routes, so uploads can be held,
 * failed and released, and a collaborator's steps are played into the editor
 * as the server would relay them. The byte cache and sign-out run against the
 * app itself in fixture mode. Real services:
 * apps/notes/scripts/attachments-e2e.mjs.
 */

interface DocJson {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocJson[];
  text?: string;
}
interface Call {
  name: string;
  args: Record<string, unknown>;
  objectId?: string;
}
/** What harness/attachments.html exposes to the tests. */
interface HarnessWindow {
  __attachments: {
    calls: Call[];
    failNextCreate: string | null;
    doc(): DocJson;
    setFiles(on: boolean): void;
    setEditable(editable: boolean): void;
    setObjects(ids: string[] | null): void;
    remote(steps: unknown[]): void;
    confirm(): void;
    load(doc: unknown): void;
    close(): void;
    admissionDelayMs: number;
    admissionWaitMs: number;
    nextSession(): void;
    setAccount(accountId: string): void;
  };
}
const api = (page: Page) => ({
  setFiles: (on: boolean) =>
    page.evaluate(
      (value) =>
        (window as unknown as HarnessWindow).__attachments.setFiles(value),
      on,
    ),
  setEditable: (on: boolean) =>
    page.evaluate(
      (value) =>
        (window as unknown as HarnessWindow).__attachments.setEditable(value),
      on,
    ),
  setObjects: (ids: string[] | null) =>
    page.evaluate(
      (value) =>
        (window as unknown as HarnessWindow).__attachments.setObjects(value),
      ids,
    ),
  load: (doc: unknown) =>
    page.evaluate(
      (value) => (window as unknown as HarnessWindow).__attachments.load(value),
      doc,
    ),
  remote: (steps: unknown[]) =>
    page.evaluate(
      (value) =>
        (window as unknown as HarnessWindow).__attachments.remote(value),
      steps,
    ),
  confirm: () =>
    page.evaluate(() =>
      (window as unknown as HarnessWindow).__attachments.confirm(),
    ),
  close: () =>
    page.evaluate(() =>
      (window as unknown as HarnessWindow).__attachments.close(),
    ),
  failNextCreate: (message: string) =>
    page.evaluate((value) => {
      (window as unknown as HarnessWindow).__attachments.failNextCreate = value;
    }, message),
  doc: () =>
    page.evaluate(() =>
      (window as unknown as HarnessWindow).__attachments.doc(),
    ),
  calls: () =>
    page.evaluate(
      () => (window as unknown as HarnessWindow).__attachments.calls,
    ),
});

const IMAGE = "k57a1b2c3d4e5f6g7h8j9k0m1n2p3q4r";
const FILE = "m57a1b2c3d4e5f6g7h8j9k0m1n2p3q4r";
const NOTE_FILES = "**/files/notes/*/*";

/** A PNG of the given size, made here so its pixel size is known. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
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
  header[8] = 8; // bits per channel
  header[9] = 2; // RGB
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = y * row + 1 + x * 3;
      raw[at] = 168;
      raw[at + 1] = 102 + ((x + y) % 40);
      raw[at + 2] = 47;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const PHOTO = png(400, 300);
const SMALL = png(40, 30);
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

async function harness(page: Page, files = true) {
  await page.goto("/harness/attachments.html");
  const editor = page.getByRole("textbox", { name: "Note content" });
  await expect(editor).toHaveClass(/ProseMirror/);
  if (files) await api(page).setFiles(true);
  return editor;
}

/** The note's top-level blocks: their text, or `image:<src>` / `file:<name>`. */
async function blocks(page: Page) {
  const doc = await api(page).doc();
  return (doc.content ?? []).map((node) =>
    node.type === "image"
      ? `image:${String(node.attrs?.src)}`
      : node.type === "file"
        ? `file:${String(node.attrs?.name)}`
        : (node.content ?? []).map((child) => child.text ?? "").join(""),
  );
}

/** The object the stand-in server gave the upload of `name`, once it has. */
async function objectFor(page: Page, name: string) {
  let objectId: string | undefined;
  await expect
    .poll(async () => {
      objectId = (await api(page).calls()).find(
        (call) => call.name === "createUpload" && call.args.name === name,
      )?.objectId;
      return objectId;
    })
    .toBeTruthy();
  return objectId!;
}

/** Put the caret at the end of the paragraph showing `text`. */
async function caretAfter(editor: Locator, text: string) {
  await editor.getByText(text, { exact: true }).click();
  await editor.press("End");
}

/** The Worker's upload route, held until released. */
async function uploads(page: Page) {
  const seen: Request[] = [];
  const waiting: { url: string; release: () => void }[] = [];
  let held = true;
  let status = 200;
  await page.route("**/files/upload/*", async (route) => {
    seen.push(route.request());
    if (held)
      await new Promise<void>((release) =>
        waiting.push({ url: route.request().url(), release }),
      );
    await route
      .fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(
          status === 200 ? { state: "ready" } : { error: "unavailable" },
        ),
      })
      .catch(() => undefined);
  });
  return {
    seen,
    waiting: () => waiting.length,
    /** Answer every waiting request, and later ones at once. */
    open() {
      held = false;
      for (const request of waiting.splice(0)) request.release();
    },
    /** Answer the waiting request for one object. */
    release(objectId: string) {
      const index = waiting.findIndex((request) =>
        request.url.endsWith("/" + objectId),
      );
      if (index >= 0) waiting.splice(index, 1)[0]!.release();
    },
    respond(next: number) {
      status = next;
    },
  };
}

async function choose(
  page: Page,
  files: { name: string; mimeType: string; buffer: Buffer }[],
) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add file" }).click();
  await (await chooser).setFiles(files);
}

const widget = (page: Page, name: string) =>
  page.getByRole("group", { name: `Upload of ${name}` });

/** A note with an attachment image and a file block; their bytes come from the routes. */
const ALBUM = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      attrs: { id: "title" },
      content: [{ type: "text", text: "Album" }],
    },
    {
      type: "image",
      attrs: {
        id: "pic",
        src: `attachment:${IMAGE}`,
        alt: "photo.png",
        title: null,
        width: null,
      },
    },
    {
      type: "file",
      attrs: {
        id: "doc",
        objectId: FILE,
        name: "report.pdf",
        mimeType: "application/pdf",
        size: 2_516_582,
      },
    },
    {
      type: "paragraph",
      attrs: { id: "end" },
      content: [{ type: "text", text: "End." }],
    },
  ],
};
const REPORT = Buffer.from("%PDF-1.7\n% attachments browser test\n");

async function album(page: Page, files = true) {
  const reads: string[] = [];
  await page.route(NOTE_FILES, async (route) => {
    expect(route.request().headers()["authorization"]).toBe(
      "Bearer harness-token",
    );
    const objectId = route.request().url().split("/").pop()!;
    reads.push(objectId);
    if (objectId === IMAGE)
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        body: PHOTO,
      });
    else if (objectId === FILE)
      await route.fulfill({
        status: 200,
        contentType: "application/octet-stream",
        body: REPORT,
      });
    else
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: "{}",
      });
  });
  const editor = await harness(page, files);
  await api(page).load(ALBUM);
  await expect(editor.locator(".note-image img")).toBeVisible();
  return { editor, reads };
}

test("+ File is offered only in an editable live note while files are on", async ({
  page,
}) => {
  await harness(page, false);
  const add = page.getByRole("button", { name: "Add file" });
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
  await expect(add).toHaveCount(0);
  await api(page).setFiles(true);
  await expect(add).toBeVisible();
  await expect(add).toHaveText("+ File");
  // No `accept` or `capture`: iOS keeps every source in its picker.
  const input = page.locator('input[type="file"]');
  await expect(input).toHaveAttribute("multiple", "");
  expect(await input.getAttribute("accept")).toBeNull();
  expect(await input.getAttribute("capture")).toBeNull();
  await api(page).setEditable(false);
  await expect(add).toHaveCount(0);
  await api(page).setEditable(true);
  await expect(add).toBeVisible();
  await api(page).setFiles(false);
  await expect(add).toHaveCount(0);
});

test("a note in the app has no + File without the server", async ({ page }) => {
  await page.goto("/?fixture=seed&session=stall");
  await page
    .getByRole("button", { name: "New note", exact: true })
    .first()
    .click();
  await expect(page.getByRole("textbox", { name: "Note content" })).toHaveClass(
    /ProseMirror/,
  );
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add file" })).toHaveCount(0);
});

test("a chosen picture uploads with progress and lands at the caret", async ({
  page,
}) => {
  const editor = await harness(page);
  const put = await uploads(page);
  let reads = 0;
  await page.route(NOTE_FILES, (route) => {
    reads++;
    return route.fulfill({ status: 404, body: "{}" });
  });
  await caretAfter(editor, "First line.");
  await choose(page, [
    { name: "photo.png", mimeType: "image/png", buffer: PHOTO },
  ]);
  const upload = widget(page, "photo.png");
  await expect(upload).toBeVisible();
  await expect(upload.getByRole("status")).toHaveText(/^Uploading… \d+%$/);
  await expect(upload.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(upload.getByRole("button", { name: "Retry" })).toBeHidden();
  await expect(upload.locator("progress")).toHaveAttribute(
    "value",
    /^[0-9.]+$/,
  );
  // A decoration, not content: the note has no trace of it, and it sits
  // where the picture will land.
  expect(await blocks(page)).toEqual(["Album", "First line.", "Second line."]);
  await expect(
    editor.locator("p:has-text('First line.') + .upload-widget"),
  ).toHaveCount(1);

  // The ticket went to the Worker in a header, the bytes in the body.
  await expect.poll(() => put.seen.length).toBe(1);
  const request = put.seen[0]!;
  expect(request.method()).toBe("PUT");
  expect(request.headers()["authorization"]).toBe(`Bearer ${"t".repeat(43)}`);
  expect(request.url()).not.toContain("t".repeat(43));
  expect(request.postDataBuffer()?.equals(PHOTO)).toBe(true);
  const [create] = await api(page).calls();
  expect(create).toMatchObject({
    name: "createUpload",
    args: {
      name: "photo.png",
      mimeType: "image/png",
      size: PHOTO.length,
      sha256: sha256(PHOTO),
    },
  });
  expect(request.url()).toMatch(
    new RegExp(`/files/upload/${create!.objectId}$`),
  );

  put.open();
  await expect(upload).toHaveCount(0);
  expect(await blocks(page)).toEqual([
    "Album",
    "First line.",
    `image:attachment:${create!.objectId}`,
    "Second line.",
  ]);
  const picture = editor.locator(".note-image img");
  await expect(picture).toBeVisible();
  await expect(picture).toHaveAttribute("alt", "photo.png");
  await expect(picture).toHaveAttribute("src", /^blob:/);
  expect(
    await picture.evaluate((img: HTMLImageElement) => img.naturalWidth),
  ).toBe(400);
  // Shown from the bytes just sent: nothing was read back from the server.
  expect(reads).toBe(0);
});

test("Cancel stops an upload and asks the server to drop it", async ({
  page,
}) => {
  const editor = await harness(page);
  const put = await uploads(page);
  await caretAfter(editor, "First line.");
  await choose(page, [
    { name: "photo.png", mimeType: "image/png", buffer: PHOTO },
  ]);
  await expect.poll(() => put.waiting()).toBe(1);
  await widget(page, "photo.png")
    .getByRole("button", { name: "Cancel" })
    .click();
  await expect(widget(page, "photo.png")).toHaveCount(0);
  put.open();
  await page.waitForTimeout(300);
  expect(await blocks(page)).toEqual(["Album", "First line.", "Second line."]);
  const calls = await api(page).calls();
  expect(calls.map((call) => call.name)).toEqual([
    "createUpload",
    "cancelUpload",
  ]);
  expect(calls[1]!.args.objectId).toBe(calls[0]!.objectId);
});

test("a failed upload keeps Retry and Remove; Retry sends the same object again", async ({
  page,
}) => {
  const editor = await harness(page);
  const put = await uploads(page);
  put.respond(503);
  put.open();
  await caretAfter(editor, "First line.");
  await choose(page, [
    { name: "photo.png", mimeType: "image/png", buffer: PHOTO },
  ]);
  const upload = widget(page, "photo.png");
  await expect(upload.getByRole("status")).toHaveText(
    "The upload failed. Check the connection and retry.",
  );
  await expect(upload.getByRole("button", { name: "Cancel" })).toBeHidden();
  await expect(upload.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(upload.getByRole("button", { name: "Remove" })).toBeVisible();
  // Still not in the note.
  expect(await blocks(page)).toEqual(["Album", "First line.", "Second line."]);
  put.respond(200);
  await upload.getByRole("button", { name: "Retry" }).click();
  await expect(upload).toHaveCount(0);
  const calls = await api(page).calls();
  expect(await blocks(page)).toEqual([
    "Album",
    "First line.",
    `image:attachment:${calls[0]!.objectId}`,
    "Second line.",
  ]);
  // The retry asked for the same upload: one object, never two.
  expect(calls.map((call) => call.name)).toEqual([
    "createUpload",
    "createUpload",
  ]);
  expect(calls[1]!.args.requestId).toBe(calls[0]!.args.requestId);
  expect(calls[1]!.objectId).toBe(calls[0]!.objectId);

  // The server's refusal shows its message; Remove drops the upload.
  await api(page).failNextCreate(
    "Too many uploads are in progress. Wait for some to finish.",
  );
  await caretAfter(editor, "Second line.");
  await choose(page, [
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") },
  ]);
  const refused = widget(page, "notes.txt");
  await expect(refused.getByRole("status")).toHaveText(
    "Too many uploads are in progress. Wait for some to finish.",
  );
  await refused.getByRole("button", { name: "Remove" }).click();
  await expect(refused).toHaveCount(0);
  expect(await blocks(page)).toEqual([
    "Album",
    "First line.",
    `image:attachment:${calls[0]!.objectId}`,
    "Second line.",
  ]);
  // Nothing was made for it, so there was nothing to cancel.
  expect((await api(page).calls()).map((call) => call.name)).toEqual([
    "createUpload",
    "createUpload",
    "createUpload",
  ]);
});

/** Paste or drop `files` (with optional other clipboard data) on the editor. */
async function transfer(
  editor: Locator,
  kind: "paste" | "drop",
  files: { name: string; type: string; base64: string }[],
  extra: Record<string, string> = {},
  at = { x: 0, y: 0 },
) {
  return editor.evaluate(
    (element, { kind, files, extra, at }) => {
      const data = new DataTransfer();
      for (const file of files)
        data.items.add(
          new File(
            [Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0))],
            file.name,
            {
              type: file.type,
            },
          ),
        );
      for (const [type, value] of Object.entries(extra))
        data.setData(type, value);
      const event =
        kind === "paste"
          ? new ClipboardEvent("paste", {
              clipboardData: data,
              bubbles: true,
              cancelable: true,
            })
          : new DragEvent("drop", {
              dataTransfer: data,
              bubbles: true,
              cancelable: true,
              clientX: at.x,
              clientY: at.y,
            });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    },
    { kind, files, extra, at },
  );
}
const pasted = {
  name: "pasted.png",
  type: "image/png",
  base64: PHOTO.toString("base64"),
};
const dropped = { ...pasted, name: "dropped.png" };

test("pasted and dropped files upload while files are on, and change nothing while off", async ({
  page,
}) => {
  const editor = await harness(page, false);
  const put = await uploads(page);
  put.open();
  await caretAfter(editor, "First line.");
  const startOf = async (text: string) => {
    const box = (await editor.getByText(text, { exact: true }).boundingBox())!;
    return { x: box.x + 1, y: box.y + box.height / 2 };
  };
  // Off: nothing uploads, as before B3.
  await transfer(editor, "paste", [pasted]);
  await transfer(editor, "drop", [dropped], {}, await startOf("Second line."));
  await page.waitForTimeout(300);
  await expect(page.locator(".upload-widget")).toHaveCount(0);
  expect(await api(page).calls()).toEqual([]);
  expect(await blocks(page)).toEqual(["Album", "First line.", "Second line."]);

  await api(page).setFiles(true);
  await caretAfter(editor, "First line.");
  expect(await transfer(editor, "paste", [pasted])).toBe(true);
  const first = await objectFor(page, "pasted.png");
  await expect
    .poll(() => blocks(page))
    .toEqual([
      "Album",
      "First line.",
      `image:attachment:${first}`,
      "Second line.",
    ]);
  // Dropped at the start of a line: it lands before that line.
  expect(
    await transfer(
      editor,
      "drop",
      [dropped],
      {},
      await startOf("Second line."),
    ),
  ).toBe(true);
  const second = await objectFor(page, "dropped.png");
  await expect
    .poll(() => blocks(page))
    .toEqual([
      "Album",
      "First line.",
      `image:attachment:${first}`,
      `image:attachment:${second}`,
      "Second line.",
    ]);
  // Copied text with a picture of it (as some apps add) pastes as text.
  await caretAfter(editor, "Second line.");
  await transfer(editor, "paste", [pasted], {
    "text/html": "<p>Copied words</p>",
    "text/plain": "Copied words",
  });
  await expect(editor).toContainText("Copied words");
  expect((await api(page).calls()).length).toBe(2);
});

test("an upload lands where typing, Enter and a collaborator's change have moved it", async ({
  page,
}) => {
  const editor = await harness(page);
  const put = await uploads(page);
  await caretAfter(editor, "First line.");
  await choose(page, [
    { name: "photo.png", mimeType: "image/png", buffer: PHOTO },
  ]);
  await expect.poll(() => put.waiting()).toBe(1);
  // While it uploads: typing after it, a new line above it, and a
  // collaborator's paragraph under the title. (Pauses let the editor read
  // each caret move, as it does between a person's taps and keys.)
  await caretAfter(editor, "Second line.");
  await editor.pressSequentially(" Typed.");
  await expect(editor.getByText("Second line. Typed.")).toBeVisible();
  await editor.getByText("First line.", { exact: true }).click();
  await page.waitForTimeout(100);
  await editor.press("Home");
  await page.waitForTimeout(100);
  await editor.press("Enter");
  await api(page).remote([
    {
      stepType: "replace",
      from: 7,
      to: 7,
      slice: {
        content: [
          {
            type: "paragraph",
            attrs: { id: "collab" },
            content: [{ type: "text", text: "From a collaborator." }],
          },
        ],
      },
    },
  ]);
  await expect(editor).toContainText("From a collaborator.");
  await expect(
    editor.locator("p:has-text('First line.') + .upload-widget"),
  ).toHaveCount(1);
  put.open();
  await expect(page.locator(".upload-widget")).toHaveCount(0);
  expect(await blocks(page)).toEqual([
    "Album",
    "From a collaborator.",
    "",
    "First line.",
    `image:attachment:${await objectFor(page, "photo.png")}`,
    "Second line. Typed.",
  ]);
});

test("files that finish out of order land in the order chosen", async ({
  page,
}) => {
  const editor = await harness(page);
  const put = await uploads(page);
  await caretAfter(editor, "First line.");
  await choose(page, [
    { name: "one.png", mimeType: "image/png", buffer: PHOTO },
    { name: "two.png", mimeType: "image/png", buffer: SMALL },
  ]);
  await expect.poll(() => put.waiting()).toBe(2);
  const one = (await objectFor(page, "one.png"))!;
  const two = (await objectFor(page, "two.png"))!;
  put.release(two);
  await expect(widget(page, "two.png")).toHaveCount(0);
  await expect(widget(page, "one.png")).toBeVisible();
  put.release(one);
  await expect(widget(page, "one.png")).toHaveCount(0);
  expect(await blocks(page)).toEqual([
    "Album",
    "First line.",
    `image:attachment:${one}`,
    `image:attachment:${two}`,
    "Second line.",
  ]);
});

test("closing the note cancels its unfinished uploads", async ({ page }) => {
  const editor = await harness(page);
  const put = await uploads(page);
  await caretAfter(editor, "First line.");
  await choose(page, [
    { name: "photo.png", mimeType: "image/png", buffer: PHOTO },
  ]);
  await expect.poll(() => put.waiting()).toBe(1);
  await api(page).close();
  await expect(page.getByText("Closed")).toBeVisible();
  const calls = await api(page).calls();
  expect(calls.map((call) => call.name)).toEqual([
    "createUpload",
    "cancelUpload",
  ]);
  expect(calls[1]!.args.objectId).toBe(calls[0]!.objectId);
  // Its bytes arriving afterwards changes nothing.
  put.open();
  await api(page).load({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Album" }] },
    ],
  });
  await expect(
    page.getByRole("textbox", { name: "Note content" }),
  ).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.locator(".upload-widget")).toHaveCount(0);
  expect(await blocks(page)).toEqual(["Album"]);
});

const widthOf = async (page: Page) =>
  (await api(page).doc()).content![1]!.attrs!.width;

test("dragging an image's corner saves its width; double-clicking it resets", async ({
  page,
}) => {
  const { editor } = await album(page);
  const picture = editor.locator(".note-image img");
  expect(
    await picture.evaluate((img: HTMLImageElement) => img.naturalWidth),
  ).toBe(400);
  // The first tap in an editable note selects it; its corner shows.
  await picture.click();
  await expect(picture).toHaveClass(/ProseMirror-selectednode/);
  const grip = editor.locator(".image-grip");
  await expect(grip).toBeVisible();
  const box = (await grip.boundingBox())!;
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const start = (await picture.boundingBox())!.width;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 6; step++)
    await page.mouse.move(from.x - step * 20, from.y);
  // The picture follows the pointer; the note changes once, on release.
  await expect
    .poll(async () => (await picture.boundingBox())!.width)
    .toBeLessThan(start - 100);
  expect(await widthOf(page)).toBeNull();
  await page.mouse.up();
  const saved = Math.round(start - 120);
  await expect.poll(() => widthOf(page)).toBe(saved);
  await expect(picture).toHaveAttribute("width", String(saved));
  // Double-click the corner: natural size again.
  await grip.dblclick();
  await expect.poll(() => widthOf(page)).toBeNull();
  await expect(picture).not.toHaveAttribute("width");
});

// ---- Review round 2 of B3, R2-2: with files off, images are as on main ----

/** Strip block IDs, which are random, from the editor's HTML. */
const withoutIds = (html: string) =>
  html.replace(/ data-block-id="[^"]*"/g, "");

/**
 * Recorded from `main` at 8e7088a with the same steps (fixture app, files
 * off): a pasted web image, then a click on it, then Enter.
 */
const MAIN = {
  html: '<p>Album</p><img src="https://example.com/w.png" alt="web" title="A title" contenteditable="false" draggable="true"><p>After</p>',
  selected:
    '<p>Album</p><img src="https://example.com/w.png" alt="web" title="A title" contenteditable="false" draggable="true" class="ProseMirror-selectednode"><p>After</p>',
  afterEnter:
    '<p>Album</p><img src="https://example.com/w.png" alt="web" title="A title" contenteditable="false" draggable="true" class=""><p><br class="ProseMirror-trailingBreak"></p><p>After</p>',
};

test("R2 R2-2: with files off, a web image renders and behaves exactly as on main", async ({
  page,
}) => {
  await page.route("https://example.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      body: png(200, 100),
    }),
  );
  await page.goto("/?fixture=seed&session=stall");
  await page
    .getByRole("button", { name: "New note", exact: true })
    .first()
    .click();
  const editor = page.getByRole("textbox", { name: "Note content" });
  await expect(editor).toHaveClass(/ProseMirror/);
  await page.waitForFunction(() =>
    performance
      .getEntriesByType("resource")
      .some((entry) => entry.name.includes("notes-core/src/markdown.ts")),
  );
  await editor.click();
  await editor.pressSequentially("Album");
  await editor.press("Enter");
  await editor.evaluate((element) => {
    const data = new DataTransfer();
    data.setData(
      "text/plain",
      '![web](https://example.com/w.png "A title")\n\nAfter',
    );
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  const picture = editor.locator("img");
  await expect(picture).toHaveCount(1);
  expect(withoutIds(await editor.innerHTML())).toBe(MAIN.html);
  expect(await editor.locator("[tabindex], [role=button]").count()).toBe(0);
  await expect
    .poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(200);
  await picture.click();
  await expect(picture).toHaveClass("ProseMirror-selectednode");
  expect(withoutIds(await editor.innerHTML())).toBe(MAIN.selected);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.className)).toBe(
    "ProseMirror ProseMirror-focused",
  );
  expect(withoutIds(await editor.innerHTML())).toBe(MAIN.afterEnter);
});

test("R2 R2-2: with files off, an attachment image and a file block render as on main, and nothing is read", async ({
  page,
}) => {
  const reads: string[] = [];
  await page.route(NOTE_FILES, (route) => {
    reads.push(route.request().url());
    return route.fulfill({ status: 404, body: "{}" });
  });
  const editor = await harness(page, false);
  await api(page).load(ALBUM);
  await expect(editor.locator("[data-object-id]")).toHaveCount(1);
  // main's own rendering of these nodes (its schema's toDOM).
  expect(withoutIds(await editor.innerHTML())).toBe(
    `<p>Album</p><img src="attachment:${IMAGE}" alt="photo.png" contenteditable="false" draggable="true">` +
      `<div data-object-id="${FILE}" data-name="report.pdf" data-mime-type="application/pdf" data-size="2516582" contenteditable="false" draggable="true">report.pdf</div>` +
      "<p>End.</p>",
  );
  expect(await editor.locator("[tabindex], [role=button]").count()).toBe(0);
  await page.waitForTimeout(300);
  expect(reads).toEqual([]);
});

test("R2 R2-2: turning files on and off swaps the rendering in place, keeping the editor's state", async ({
  page,
}) => {
  const { editor } = await album(page);
  await caretAfter(editor, "End.");
  await editor.pressSequentially(" Typed");
  await expect(editor.locator(".note-image")).toHaveCount(1);
  await api(page).setFiles(false);
  await expect(editor.locator(".note-image")).toHaveCount(0);
  await expect(editor.locator(`img[src="attachment:${IMAGE}"]`)).toHaveCount(1);
  await expect(editor).toContainText("End. Typed");
  // The history survives the swap: Undo takes back the typing.
  await editor.press("ControlOrMeta+z");
  await expect(editor).not.toContainText("Typed");
  await expect(editor).toContainText("End.");
  await api(page).setFiles(true);
  await expect(editor.locator(".note-image img")).toBeVisible();
  await expect(editor.locator(`img[src="attachment:${IMAGE}"]`)).toHaveCount(0);
});

test("a tap opens the lightbox; Escape, the backdrop and × close it", async ({
  page,
}) => {
  const { editor } = await album(page);
  const picture = editor.locator(".note-image img");
  const lightbox = page.getByRole("dialog", { name: "Picture: photo.png" });
  // In an editable note the first tap selects; a tap on the selected image opens it.
  await picture.click();
  await expect(picture).toHaveClass(/ProseMirror-selectednode/);
  await expect(lightbox).toBeHidden();
  await picture.click();
  await expect(lightbox).toBeVisible();
  await expect(lightbox.locator("img")).toHaveAttribute("src", /^blob:/);
  await page.keyboard.press("Escape");
  await expect(lightbox).toBeHidden();
  // The backdrop: anywhere outside the picture.
  await picture.click();
  await expect(lightbox).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(lightbox).toBeHidden();
  await picture.click();
  await expect(lightbox).toBeVisible();
  await lightbox.getByRole("button", { name: "Close picture" }).click();
  await expect(lightbox).toBeHidden();
  // A read-only note opens it with one tap.
  await api(page).setEditable(false);
  await editor.getByText("End.").click();
  await picture.click();
  await expect(lightbox).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(lightbox).toBeHidden();
});

test("a file shows as a chip with its type and size, and downloads", async ({
  page,
}) => {
  const { editor } = await album(page);
  const block = editor.locator("[data-object-id]");
  const chip = block.locator(".file-chip");
  await expect(block).toHaveCount(1);
  await expect(chip.locator(".file-name")).toHaveText("report.pdf");
  await expect(chip.locator(".file-meta")).toHaveText("PDF · 2.4 MB");
  await expect(chip.locator("svg")).toHaveCount(1);
  // Editable: the first tap selects; a tap on the selected chip downloads.
  await chip.click();
  await expect(block).toHaveClass(/ProseMirror-selectednode/);
  const download = page.waitForEvent("download");
  await chip.click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("report.pdf");
  expect((await readFile(await file.path())).equals(REPORT)).toBe(true);
  // Read-only: one tap downloads.
  await api(page).setEditable(false);
  const again = page.waitForEvent("download");
  await chip.click();
  expect((await again).suggestedFilename()).toBe("report.pdf");
});

test("a reference the server does not hold shows Attachment unavailable", async ({
  page,
}) => {
  const { editor, reads } = await album(page);
  const block = editor.locator("[data-object-id]");
  // The server lists only the image for this note: the file is unavailable.
  await api(page).setObjects([IMAGE]);
  await expect(block.locator(".file-meta")).toHaveText(
    "Attachment unavailable",
  );
  await expect(editor.locator(".note-image img")).toBeVisible();
  // Then neither: the picture's bytes, though here, are not shown.
  await api(page).setObjects([]);
  const placeholder = editor.locator(".note-image .attachment-placeholder");
  await expect(placeholder).toHaveText("Attachment unavailable");
  await expect(editor.locator(".note-image img")).toHaveCount(0);
  // Tapping the chip downloads nothing.
  await block.locator(".file-chip").click();
  await block.locator(".file-chip").click();
  await expect(page.locator(".link-notice")).toHaveText(
    "This attachment is unavailable.",
  );

  // A reference the Worker refuses (404), and a source from before
  // attachments that names no object, are unavailable too.
  await api(page).setObjects(null);
  await api(page).load({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Missing" }] },
      {
        type: "image",
        attrs: {
          src: "attachment:z00000000000000000000000000missing",
          alt: "gone",
        },
      },
      { type: "image", attrs: { src: "attachment:Not-An-Id", alt: "legacy" } },
    ],
  });
  await expect(editor.locator(".attachment-placeholder")).toHaveText([
    "Attachment unavailable",
    "Attachment unavailable",
  ]);
  expect(reads).toContain("z00000000000000000000000000missing");
});

test("a copied attachment the server has not seen yet waits instead of showing unavailable", async ({
  page,
}) => {
  const reads: string[] = [];
  let known = false;
  await page.route(NOTE_FILES, (route) => {
    reads.push(route.request().url().split("/").pop()!);
    return known
      ? route.fulfill({ status: 200, contentType: "image/png", body: PHOTO })
      : route.fulfill({ status: 404, body: "{}" });
  });
  const editor = await harness(page);
  await api(page).setObjects([]);
  await caretAfter(editor, "First line.");
  // As if copied from another note: an attachment image this note lacks.
  await editor.evaluate((element, id) => {
    const data = new DataTransfer();
    data.setData("text/html", `<img src="attachment:${id}" alt="copied">`);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, IMAGE);
  const view = editor.locator(".note-image");
  await expect.poll(() => reads.length).toBeGreaterThan(0);
  await expect(view).toHaveAttribute("data-status", "loading");
  // The server accepts the change; its list for the note now has the
  // object, and the picture loads.
  known = true;
  await api(page).confirm();
  await api(page).setObjects([IMAGE]);
  await expect(view.locator("img")).toBeVisible();
});

/** The attachment bytes this page keeps in memory (object IDs). */
function cachedObjects(page: Page) {
  return page.evaluate(async () => {
    const url = "/src/attachment-cache.ts";
    const { attachmentCache } = (await import(
      /* @vite-ignore */ url
    )) as typeof import("../../apps/notes/src/attachment-cache");
    return attachmentCache.objects();
  });
}

test("signing out clears the attachment bytes in memory", async ({ page }) => {
  await page.goto("/?fixture=seed&session=ready");
  await expect(
    page.getByRole("button", { name: /Welcome to your notes/ }),
  ).toBeVisible();
  // Files on, and bytes of this account, as showing a picture keeps them.
  await page.evaluate(async (objectId) => {
    const capability = "/src/file-capability.ts";
    const { setFileWrites } = (await import(
      /* @vite-ignore */ capability
    )) as typeof import("../../apps/notes/src/file-capability");
    setFileWrites(true);
    const url = "/src/attachment-cache.ts";
    const { attachmentCache } = (await import(
      /* @vite-ignore */ url
    )) as typeof import("../../apps/notes/src/attachment-cache");
    attachmentCache.store(
      attachmentCache.current(),
      objectId,
      new Blob([new Uint8Array(64)], { type: "image/png" }),
    );
  }, IMAGE);
  expect(await cachedObjects(page)).toEqual([IMAGE]);
  await page.locator(".connection-status").click();
  await page.getByRole("button", { name: "Sign out…" }).click();
  await page.getByRole("button", { name: "Sign out of this device" }).click();
  await expect.poll(() => cachedObjects(page)).toEqual([]);
});

// ---- Review round 1 of B3: regression tests (fail on 85a42c7) ----

/** Settings of the harness's stand-in server. */
const configure = (
  page: Page,
  values: Partial<{ admissionDelayMs: number; admissionWaitMs: number }>,
) =>
  page.evaluate(
    (settings) =>
      Object.assign(
        (window as unknown as HarnessWindow).__attachments,
        settings,
      ),
    values,
  );
const nextSession = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as HarnessWindow).__attachments.nextSession(),
  );

/** `/files/notes/*` answered from the album's bytes; `hold` keeps one waiting. */
async function heldReads(page: Page, hold: string) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const reads: string[] = [];
  await page.route(NOTE_FILES, async (route) => {
    const objectId = route.request().url().split("/").pop()!;
    reads.push(objectId);
    if (objectId === hold) await held;
    await route
      .fulfill(
        objectId === IMAGE
          ? { status: 200, contentType: "image/png", body: PHOTO }
          : objectId === FILE
            ? {
                status: 200,
                contentType: "application/octet-stream",
                body: REPORT,
              }
            : { status: 404, body: "{}" },
      )
      .catch(() => undefined);
  });
  return { reads, release };
}

test("R1 F3: a picture read that finishes after the server took the object away shows and caches nothing", async ({
  page,
}) => {
  const { release } = await heldReads(page, IMAGE);
  const editor = await harness(page);
  await api(page).setObjects([IMAGE, FILE]);
  await api(page).load(ALBUM);
  const view = editor.locator(".note-image");
  await expect(view).toHaveAttribute("data-status", "loading");
  await api(page).setObjects([FILE]);
  await expect(view.locator(".attachment-placeholder")).toHaveText(
    "Attachment unavailable",
  );
  release();
  await page.waitForTimeout(500);
  await expect(view.locator("img")).toHaveCount(0);
  await expect(view).toHaveAttribute("data-status", "unavailable");
  expect(await cachedObjects(page)).not.toContain(IMAGE);
});

test("R1 F3: a download that finishes after the note closed starts nothing", async ({
  page,
}) => {
  const { release } = await heldReads(page, FILE);
  const editor = await harness(page);
  await api(page).load(ALBUM);
  await expect(editor.locator(".note-image img")).toBeVisible();
  let downloads = 0;
  page.on("download", () => downloads++);
  const chip = editor.locator(".file-chip");
  await chip.click();
  await chip.click();
  await expect(chip.locator(".file-meta")).toHaveText("Downloading…");
  await api(page).close();
  release();
  await page.waitForTimeout(1_000);
  expect(downloads).toBe(0);
});

test("R1 F3: the lightbox closes when its picture becomes unavailable, and when the session moves on", async ({
  page,
}) => {
  const { editor } = await album(page);
  await api(page).setObjects([IMAGE, FILE]);
  const picture = editor.locator(".note-image img");
  const lightbox = page.getByRole("dialog", { name: "Picture: photo.png" });
  const open = async () => {
    await picture.click();
    if (!(await lightbox.isVisible())) await picture.click();
    await expect(lightbox).toBeVisible();
  };
  await open();
  await api(page).setObjects([FILE]);
  await expect(lightbox).toBeHidden();
  await api(page).setObjects([IMAGE, FILE]);
  await expect(picture).toBeVisible();
  await open();
  await nextSession(page);
  await expect(lightbox).toBeHidden();
});

test("R1 F5: a picture that arrives before the server lists it loads once it does", async ({
  page,
}) => {
  const { reads } = await heldReads(page, "none");
  const editor = await harness(page);
  await api(page).setObjects([]);
  // A collaborator adds the picture after "First line.".
  await api(page).remote([
    {
      stepType: "replace",
      from: 20,
      to: 20,
      slice: {
        content: [
          {
            type: "image",
            attrs: { id: "remote", src: `attachment:${IMAGE}`, alt: "remote" },
          },
        ],
      },
    },
  ]);
  const view = editor.locator(".note-image");
  await expect(view.locator(".attachment-placeholder")).toHaveText(
    "Attachment unavailable",
  );
  await api(page).setObjects([IMAGE]);
  await expect(view.locator("img")).toBeVisible();
  expect(reads).toContain(IMAGE);
});

test("R1 F6: a pasted attachment the server did not record stops showing once acknowledged", async ({
  page,
}) => {
  const { editor } = await album(page); // the picture's bytes are now cached
  await api(page).load({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Album" }] },
      { type: "paragraph", content: [{ type: "text", text: "First line." }] },
    ],
  });
  await api(page).setObjects([]);
  await caretAfter(editor, "First line.");
  await editor.evaluate((element, id) => {
    const data = new DataTransfer();
    data.setData("text/html", `<img src="attachment:${id}" alt="copied">`);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, IMAGE);
  const view = editor.locator(".note-image");
  // Shown from the cache while the paste is unsent.
  await expect(view.locator("img")).toBeVisible();
  // Acknowledged, and the server's list (unchanged, so no new answer) lacks it.
  await api(page).confirm();
  await expect(view.locator(".attachment-placeholder")).toHaveText(
    "Attachment unavailable",
  );
  await expect(view.locator("img")).toHaveCount(0);
});

test("R1 F7: an admission that answers after the wait is released when the upload is removed", async ({
  page,
}) => {
  const editor = await harness(page);
  await configure(page, { admissionDelayMs: 1_500, admissionWaitMs: 300 });
  await caretAfter(editor, "First line.");
  await choose(page, [
    { name: "photo.png", mimeType: "image/png", buffer: PHOTO },
  ]);
  const upload = widget(page, "photo.png");
  await expect(upload.getByRole("status")).toHaveText(
    "The server did not answer. Check the connection and retry.",
  );
  await upload.getByRole("button", { name: "Remove" }).click();
  await expect(upload).toHaveCount(0);
  await expect
    .poll(async () => (await api(page).calls()).map((call) => call.name))
    .toEqual(["createUpload", "cancelUpload"]);
  const calls = await api(page).calls();
  expect(calls[1]!.args.objectId).toBe(calls[0]!.objectId);
});

test("R1 F7: Cancel while the server has not answered releases the object once it does, once", async ({
  page,
}) => {
  const editor = await harness(page);
  await configure(page, { admissionDelayMs: 1_000 });
  await caretAfter(editor, "First line.");
  await choose(page, [
    { name: "photo.png", mimeType: "image/png", buffer: PHOTO },
  ]);
  const upload = widget(page, "photo.png");
  await expect(upload.getByRole("status")).toHaveText("Preparing…");
  await expect.poll(async () => (await api(page).calls()).length).toBe(1);
  await upload.getByRole("button", { name: "Cancel" }).click();
  await expect(upload).toHaveCount(0);
  await page.waitForTimeout(1_500);
  const calls = await api(page).calls();
  expect(calls.map((call) => call.name)).toEqual([
    "createUpload",
    "cancelUpload",
  ]);
  expect(calls[1]!.args.objectId).toBe(calls[0]!.objectId);
});

test("R1 F7: Retry after the wait keeps the request, and the late answer releases nothing", async ({
  page,
}) => {
  const editor = await harness(page);
  const put = await uploads(page);
  put.open();
  await configure(page, { admissionDelayMs: 1_500, admissionWaitMs: 300 });
  await caretAfter(editor, "First line.");
  await choose(page, [
    { name: "photo.png", mimeType: "image/png", buffer: PHOTO },
  ]);
  const upload = widget(page, "photo.png");
  await expect(upload.getByRole("status")).toHaveText(
    "The server did not answer. Check the connection and retry.",
  );
  await configure(page, { admissionDelayMs: 0 });
  await upload.getByRole("button", { name: "Retry" }).click();
  await expect(upload).toHaveCount(0);
  const calls = await api(page).calls();
  expect(calls.map((call) => call.name)).toEqual([
    "createUpload",
    "createUpload",
  ]);
  expect(calls[1]!.args.requestId).toBe(calls[0]!.args.requestId);
  // The first answer arrives after the picture landed: nothing is released.
  await page.waitForTimeout(1_500);
  expect((await api(page).calls()).map((call) => call.name)).toEqual([
    "createUpload",
    "createUpload",
  ]);
  expect(await blocks(page)).toContain(
    `image:attachment:${calls[0]!.objectId}`,
  );
});

test("R1 F8: pictures and files open from the keyboard; pictures resize with labelled controls", async ({
  page,
}) => {
  const { editor } = await album(page);
  const frame = editor.locator(".note-image-frame");
  await expect(frame).toHaveAttribute("role", "button");
  await expect(frame).toHaveAttribute("tabindex", "0");
  await expect(frame).toHaveAttribute("aria-label", "View picture: photo.png");
  const lightbox = page.getByRole("dialog", { name: "Picture: photo.png" });
  await frame.focus();
  await page.keyboard.press("Enter");
  await expect(lightbox).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(lightbox).toBeHidden();
  await frame.focus();
  await page.keyboard.press(" ");
  await expect(lightbox).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(lightbox).toBeHidden();

  // Resizing without a pointer: labelled buttons, and keys on the picture.
  await frame.focus();
  const sizes = editor.getByRole("group", { name: "Picture size" });
  await expect(sizes).toBeVisible();
  const shown = (await editor.locator(".note-image img").boundingBox())!.width;
  await sizes.getByRole("button", { name: "Smaller" }).click();
  await expect.poll(() => widthOf(page)).toBe(Math.round(shown * 0.8));
  await sizes.getByRole("button", { name: "Natural size" }).click();
  await expect.poll(() => widthOf(page)).toBeNull();
  await frame.focus();
  await page.keyboard.press("-");
  await expect.poll(() => widthOf(page)).toBe(Math.round(shown * 0.8));
  await page.keyboard.press("0");
  await expect.poll(() => widthOf(page)).toBeNull();

  // A file chip downloads from the keyboard.
  const chip = editor.locator(".file-chip");
  await expect(chip).toHaveAttribute("role", "button");
  await expect(chip).toHaveAttribute(
    "aria-label",
    "Download report.pdf, PDF, 2.4 MB",
  );
  const download = page.waitForEvent("download");
  await chip.focus();
  await page.keyboard.press("Enter");
  expect((await download).suggestedFilename()).toBe("report.pdf");
});

// ---- Review round 3 of B3: memory only, and the files gate (R3-3) ----

test("R3: nothing persists attachment bytes; a reload reads the picture again", async ({
  page,
}) => {
  const { reads } = await heldReads(page, "none");
  const editor = await harness(page);
  await api(page).load(ALBUM);
  await expect(editor.locator(".note-image img")).toBeVisible();
  expect(reads.filter((id) => id === IMAGE)).toHaveLength(1);
  expect(await cachedObjects(page)).toContain(IMAGE);
  const stored = await page.evaluate(async () => ({
    databases: (await indexedDB.databases()).map((db) => db.name),
    keys: Object.keys(localStorage),
  }));
  expect(stored.databases).not.toContain("palladian-attachments");
  expect(stored.keys.filter((key) => key.includes("attachment"))).toEqual([]);
  await page.reload();
  await api(page).setFiles(true);
  await api(page).load(ALBUM);
  await expect(editor.locator(".note-image img")).toBeVisible();
  expect(reads.filter((id) => id === IMAGE)).toHaveLength(2);
});

test("R3: Ada, then Bob, then Ada in one page never shows bytes kept before", async ({
  page,
}) => {
  const { reads } = await heldReads(page, "none");
  const editor = await harness(page);
  await api(page).load(ALBUM);
  const picture = editor.locator(".note-image img");
  await expect(picture).toBeVisible();
  const count = () => reads.filter((id) => id === IMAGE).length;
  expect(count()).toBe(1);
  await page.evaluate(() =>
    (window as unknown as HarnessWindow).__attachments.setAccount("bob"),
  );
  await expect.poll(count).toBe(2);
  await expect(picture).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as HarnessWindow).__attachments.setAccount(
      "harness-account",
    ),
  );
  // Read again from the Worker: nothing from Ada's earlier session is kept.
  await expect.poll(count).toBe(3);
  await expect(picture).toBeVisible();
});

test("R3-3: an upload held at admission when files turn off sends no bytes, and its late admission is released", async ({
  page,
}) => {
  const editor = await harness(page);
  const put = await uploads(page);
  put.open();
  await configure(page, { admissionDelayMs: 1_000 });
  await caretAfter(editor, "First line.");
  await choose(page, [
    { name: "photo.png", mimeType: "image/png", buffer: PHOTO },
  ]);
  const upload = widget(page, "photo.png");
  await expect(upload.getByRole("status")).toHaveText("Preparing…");
  await expect.poll(async () => (await api(page).calls()).length).toBe(1);
  await api(page).setFiles(false);
  await expect(upload.getByRole("status")).toHaveText(
    "Files were turned off on the server.",
  );
  await expect(upload.getByRole("button", { name: "Retry" })).toBeHidden();
  await expect(upload.getByRole("button", { name: "Remove" })).toBeVisible();
  await page.waitForTimeout(1_500);
  expect(put.seen).toHaveLength(0);
  const calls = await api(page).calls();
  expect(calls.map((call) => call.name)).toEqual([
    "createUpload",
    "cancelUpload",
  ]);
  expect(calls[1]!.args.objectId).toBe(calls[0]!.objectId);
  expect(await cachedObjects(page)).toEqual([]);
  expect(await blocks(page)).toEqual(["Album", "First line.", "Second line."]);
});

test("R3-3: no Retry while files are off; once on, Retry starts a new upload", async ({
  page,
}) => {
  const editor = await harness(page);
  const put = await uploads(page);
  put.respond(503);
  put.open();
  await caretAfter(editor, "First line.");
  await choose(page, [
    { name: "photo.png", mimeType: "image/png", buffer: PHOTO },
  ]);
  const upload = widget(page, "photo.png");
  const retry = upload.getByRole("button", { name: "Retry" });
  await expect(retry).toBeVisible();
  await api(page).setFiles(false);
  await expect(retry).toBeHidden();
  await expect(upload.getByRole("button", { name: "Remove" })).toBeVisible();
  await page.waitForTimeout(300);
  // Nothing was asked of the server while off beyond releasing the object.
  const before = await api(page).calls();
  expect(before.map((call) => call.name)).toEqual([
    "createUpload",
    "cancelUpload",
  ]);
  put.respond(200);
  await api(page).setFiles(true);
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(upload).toHaveCount(0);
  const calls = await api(page).calls();
  expect(calls.map((call) => call.name)).toEqual([
    "createUpload",
    "cancelUpload",
    "createUpload",
  ]);
  // The released object is not reused: a new request.
  expect(calls[2]!.args.requestId).not.toBe(calls[0]!.args.requestId);
  expect(await blocks(page)).toContain(
    `image:attachment:${calls[2]!.objectId}`,
  );
});

test("R3-3: a download held when files turn off delivers and caches nothing", async ({
  page,
}) => {
  const { release } = await heldReads(page, FILE);
  const editor = await harness(page);
  await api(page).load(ALBUM);
  await expect(editor.locator(".note-image img")).toBeVisible();
  let downloads = 0;
  page.on("download", () => downloads++);
  const chip = editor.locator(".file-chip");
  await chip.click();
  await chip.click();
  await expect(chip.locator(".file-meta")).toHaveText("Downloading…");
  await api(page).setFiles(false);
  release();
  await page.waitForTimeout(1_000);
  expect(downloads).toBe(0);
  expect(await cachedObjects(page)).not.toContain(FILE);
});
