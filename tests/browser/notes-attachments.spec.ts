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

test("without files on, an image has no resize corner", async ({ page }) => {
  const { editor } = await album(page, false);
  const picture = editor.locator(".note-image img");
  await picture.click();
  await expect(picture).toHaveClass(/ProseMirror-selectednode/);
  await expect(editor.locator(".image-grip")).toHaveCount(0);
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

test("the byte cache keeps one account's bytes and drops the least recently used past its cap", async ({
  page,
}) => {
  await harness(page);
  const result = await page.evaluate(async () => {
    const url = "/src/attachment-cache.ts";
    const { AttachmentCache } = (await import(
      /* @vite-ignore */ url
    )) as typeof import("../../apps/notes/src/attachment-cache");
    const cache = new AttachmentCache(
      "palladian-attachments-eviction-test",
      300,
    );
    const bytes = (n: number) =>
      new Blob([new Uint8Array(n)], { type: "image/png" });
    const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
    await cache.retain("ada");
    const epoch = cache.mark("ada");
    await cache.store("ada", "o1", bytes(120), epoch);
    await pause();
    await cache.store("ada", "o2", bytes(120), epoch);
    await pause();
    await cache.read("ada", "o1"); // o1 is now the more recently used
    await pause();
    await cache.store("ada", "o3", bytes(120), epoch);
    const kept = await cache.objects("ada");
    const total = await cache.size();
    // Another account reads nothing; retaining it deletes Ada's bytes.
    const other = await cache.read("bob", "o1");
    await cache.retain("bob");
    const afterSwitch = await cache.objects("ada");
    // Bytes fetched for Ada before that are not stored afterwards.
    await cache.store("ada", "late", bytes(10), epoch);
    const late = await cache.objects("ada");
    cache.close();
    return { kept, total, other, afterSwitch, late };
  });
  expect(result.kept.sort()).toEqual(["o1", "o3"]);
  expect(result.total).toBe(240);
  expect(result.other).toBeNull();
  expect(result.afterSwitch).toEqual([]);
  expect(result.late).toEqual([]);
});

/** The app's attachment bytes in IndexedDB: account and object only. */
function cachedRows(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ accountId: string; objectId: string }[]>(
        (resolve, reject) => {
          const open = indexedDB.open("palladian-attachments");
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            if (!db.objectStoreNames.contains("bytes")) {
              db.close();
              resolve([]);
              return;
            }
            const request = db
              .transaction("bytes")
              .objectStore("bytes")
              .getAll();
            request.onsuccess = () => {
              db.close();
              resolve(
                (
                  request.result as { accountId: string; objectId: string }[]
                ).map(({ accountId, objectId }) => ({ accountId, objectId })),
              );
            };
            request.onerror = () => reject(request.error);
          };
        },
      ),
  );
}

test("signing out deletes the account's attachment bytes; another account's go at start", async ({
  page,
}) => {
  await page.goto("/?fixture=seed&session=ready");
  await expect(
    page.getByRole("button", { name: /Welcome to your notes/ }),
  ).toBeVisible();
  // Bytes another account left behind, then bytes of this account, as
  // showing a picture keeps them.
  await page.evaluate(async () => {
    const url = "/src/attachment-cache.ts";
    const { AttachmentCache, attachmentCache } = (await import(
      /* @vite-ignore */ url
    )) as typeof import("../../apps/notes/src/attachment-cache");
    const other = new AttachmentCache();
    await other.retain("someone-else");
    await other.store(
      "someone-else",
      "m57a1b2c3d4e5f6g7h8j9k0m1n2p3q4r",
      new Blob([new Uint8Array(8)]),
    );
    other.close();
    await attachmentCache.store(
      "fixture-account",
      "k57a1b2c3d4e5f6g7h8j9k0m1n2p3q4r",
      new Blob([new Uint8Array(64)], { type: "image/png" }),
    );
  });
  const mine = {
    accountId: "fixture-account",
    objectId: "k57a1b2c3d4e5f6g7h8j9k0m1n2p3q4r",
  };
  expect(await cachedRows(page)).toEqual(
    expect.arrayContaining([
      mine,
      {
        accountId: "someone-else",
        objectId: "m57a1b2c3d4e5f6g7h8j9k0m1n2p3q4r",
      },
    ]),
  );
  // Starting again as this account removes the other account's bytes.
  await page.reload();
  await expect(
    page.getByRole("button", { name: /Welcome to your notes/ }),
  ).toBeVisible();
  await expect.poll(() => cachedRows(page)).toEqual([mine]);
  // Signing out removes this account's bytes with its notes (D28).
  await page.locator(".connection-status").click();
  await page.getByRole("button", { name: "Sign out…" }).click();
  await page.getByRole("button", { name: "Sign out of this device" }).click();
  await expect.poll(() => cachedRows(page)).toEqual([]);
});
