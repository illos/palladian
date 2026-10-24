import { readFile } from "node:fs/promises";
import { crc32, deflateSync } from "node:zlib";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { formatSize } from "../../apps/notes/src/file-notes";

/**
 * File notes and the PDF reader (plan 08, B4).
 *
 * Most tests use the test-only editor harness (harness/attachments.html):
 * the real note editor bound like a live note, a stand-in for the server's
 * file functions, and Playwright routes answering the Worker's `/files/*`
 * (mocked). pdf.js is real and parses PDFs generated here. The note list
 * runs in the app's fixture mode (real list, notes cache and session, no
 * server; files turned on through the app's own module). Making a file
 * note from the list (Upload, a drop) needs the server and is proven in
 * apps/notes/scripts/file-notes-e2e.mjs against dev Convex.
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
interface HarnessWindow {
  __attachments: {
    calls: Call[];
    admissionDelayMs: number;
    doc(): DocJson;
    setFiles(on: boolean): void;
    setEditable(editable: boolean): void;
    setObjects(ids: string[] | null): void;
    load(doc: unknown): void;
    close(): void;
    nextSession(): void;
    clearCache(): void;
    fileNote(
      title: string,
      file: { name: string; type: string; base64: string },
    ): void;
    fileNoteTaken: boolean;
  };
}
const api = (page: Page) => ({
  setFiles: (on: boolean) =>
    page.evaluate(
      (on) => (window as unknown as HarnessWindow).__attachments.setFiles(on),
      on,
    ),
  setEditable: (on: boolean) =>
    page.evaluate(
      (on) =>
        (window as unknown as HarnessWindow).__attachments.setEditable(on),
      on,
    ),
  setObjects: (ids: string[] | null) =>
    page.evaluate(
      (ids) =>
        (window as unknown as HarnessWindow).__attachments.setObjects(ids),
      ids,
    ),
  load: (value: unknown) =>
    page.evaluate(
      (value) => (window as unknown as HarnessWindow).__attachments.load(value),
      value,
    ),
  close: () =>
    page.evaluate(() =>
      (window as unknown as HarnessWindow).__attachments.close(),
    ),
  nextSession: () =>
    page.evaluate(() =>
      (window as unknown as HarnessWindow).__attachments.nextSession(),
    ),
  delay: (ms: number) =>
    page.evaluate((ms) => {
      (window as unknown as HarnessWindow).__attachments.admissionDelayMs = ms;
    }, ms),
  doc: () =>
    page.evaluate(() =>
      (window as unknown as HarnessWindow).__attachments.doc(),
    ),
  calls: () =>
    page.evaluate(
      () => (window as unknown as HarnessWindow).__attachments.calls,
    ),
  taken: () =>
    page.evaluate(
      () => (window as unknown as HarnessWindow).__attachments.fileNoteTaken,
    ),
  fileNote: (title: string, name: string, type: string, bytes: Buffer) =>
    page.evaluate(
      (file) =>
        (window as unknown as HarnessWindow).__attachments.fileNote(
          file.title,
          file,
        ),
      { title, name, type, base64: bytes.toString("base64") },
    ),
});

/**
 * A small PDF: one page per entry, each line set in Helvetica. Generated
 * here (no private content); pdf.js parses it as any PDF.
 */
function pdf(pages: string[][]): Buffer {
  const objects: string[] = [];
  const escape = (text: string) => text.replace(/[\\()]/g, (c) => "\\" + c);
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
  const offsets: number[] = [];
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

/** A PNG of the given size. */
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

const PDF_ID = "p57a1b2c3d4e5f6g7h8j9k0m1n2p3q4r";
const IMAGE_ID = "k57a1b2c3d4e5f6g7h8j9k0m1n2p3q4r";
const ZIP_ID = "z57a1b2c3d4e5f6g7h8j9k0m1n2p3q4r";
const PAGES = 30;
const REPORT = pdf(
  Array.from({ length: PAGES }, (_, index) => [
    `Page ${index + 1} heading`,
    `The quick brown fox ${index + 1}`,
    index === 2 || index === 19 ? "needle in a haystack" : "plain words",
  ]),
);
/** How the app labels the PDF's size. */
const REPORT_SIZE = formatSize(REPORT.length);
const PHOTO = png(40, 30);
const ARCHIVE = Buffer.from("PK\u0005\u0006 file notes browser test\n");

const paragraph = (id: string, text: string): DocJson => ({
  type: "paragraph",
  attrs: { id },
  ...(text ? { content: [{ type: "text", text }] } : {}),
});
const pdfBlock = (id = "pdf"): DocJson => ({
  type: "file",
  attrs: {
    id,
    objectId: PDF_ID,
    name: "report.pdf",
    mimeType: "application/pdf",
    size: REPORT.length,
  },
});
const zipBlock: DocJson = {
  type: "file",
  attrs: {
    id: "zip",
    objectId: ZIP_ID,
    name: "archive.zip",
    mimeType: "application/zip",
    size: 2_516_582,
  },
};
const imageBlock: DocJson = {
  type: "image",
  attrs: {
    id: "pic",
    src: `attachment:${IMAGE_ID}`,
    alt: "harbour.png",
    title: null,
    width: 120,
  },
};
const doc = (...content: DocJson[]) => ({ type: "doc", content });
/** A file note: its title, the PDF, notes below. */
const PDF_NOTE = doc(
  paragraph("title", "report.pdf"),
  pdfBlock(),
  paragraph("notes", "Notes about it."),
);
/** An ordinary note with a PDF chip in it. */
const CHIP_NOTE = doc(
  paragraph("title", "Album"),
  paragraph("first", "First line."),
  pdfBlock(),
  paragraph("end", "End."),
);

/** `/files/notes/*` answered with the files' bytes; one object's reads can be held. */
async function serve(
  page: Page,
  options: { hold?: string; pdf?: Buffer } = {},
) {
  const reads: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/files/notes/*/*", async (route) => {
    const objectId = route.request().url().split("/").pop()!;
    reads.push(objectId);
    if (objectId === options.hold) await held;
    await route
      .fulfill(
        objectId === PDF_ID
          ? {
              status: 200,
              contentType: "application/octet-stream",
              body: options.pdf ?? REPORT,
            }
          : objectId === IMAGE_ID
            ? { status: 200, contentType: "image/png", body: PHOTO }
            : objectId === ZIP_ID
              ? {
                  status: 200,
                  contentType: "application/octet-stream",
                  body: ARCHIVE,
                }
              : { status: 404, body: "{}" },
      )
      .catch(() => undefined);
  });
  return { reads, release };
}

/** The Worker's upload route, answering at once or holding. */
async function uploads(page: Page) {
  const seen: string[] = [];
  let status = 200;
  let held = false;
  const waiting: (() => void)[] = [];
  await page.route("**/files/upload/*", async (route) => {
    seen.push(route.request().url().split("/").pop()!);
    if (held) await new Promise<void>((resolve) => waiting.push(resolve));
    await route
      .fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(status === 200 ? { state: "ready" } : {}),
      })
      .catch(() => undefined);
  });
  return {
    seen,
    hold: () => (held = true),
    release() {
      held = false;
      for (const resolve of waiting.splice(0)) resolve();
    },
    respond: (next: number) => (status = next),
  };
}

async function harness(page: Page, files = true) {
  await page.goto("/harness/attachments.html");
  const editor = page.getByRole("textbox", { name: "Note content" });
  await expect(editor).toHaveClass(/ProseMirror/);
  if (files) await api(page).setFiles(true);
  return editor;
}

/** The note's top-level blocks: their text, or `image:<src>` / `file:<name>`. */
async function blocks(page: Page) {
  const value = await api(page).doc();
  return (value.content ?? []).map((node) =>
    node.type === "image"
      ? `image:${String(node.attrs?.src)}`
      : node.type === "file"
        ? `file:${String(node.attrs?.name)}`
        : (node.content ?? []).map((child) => child.text ?? "").join(""),
  );
}

/** Whether this page has loaded the reader or pdf.js at all. */
const readerLoaded = (page: Page) =>
  page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .some((entry) => /pdfjs-dist|pdf-reader/.test(entry.name)),
  );

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

const reader = (scope: Page | Locator) =>
  scope.getByRole("group", { name: "PDF: report.pdf" });

/** The reader's page drawn and its text read. */
async function drawn(scope: Page | Locator, number = 1) {
  const view = reader(scope);
  const at = view.locator(`.pdf-page[data-page="${number}"]`);
  await expect(at.locator("canvas")).toBeVisible();
  await expect(at.locator(".pdf-text span").first()).toHaveText(
    `Page ${number} heading`,
  );
  return view;
}

/** Open the thumbnail rail, docked or as a drawer. */
async function thumbnails(page: Page, view: Locator) {
  const rail = page.getByRole("navigation", { name: "Page thumbnails" });
  if (!(await rail.isVisible()))
    await view.getByRole("button", { name: "Show page thumbnails" }).click();
  await expect(rail).toBeVisible();
  return rail;
}

/**
 * Open a chip: in an editable note the first tap selects it and a tap on
 * the selected chip opens it.
 */
async function openChip(chip: Locator) {
  const block = chip.locator("xpath=..");
  if (
    !/ProseMirror-selectednode/.test((await block.getAttribute("class")) ?? "")
  )
    await chip.click();
  await expect(block).toHaveClass(/ProseMirror-selectednode/);
  await chip.click();
}

test("a PDF file note shows the reader inline, loaded only then: pages, thumbnails and page jump", async ({
  page,
}) => {
  await serve(page);
  const editor = await harness(page);
  expect(await readerLoaded(page)).toBe(false);
  await api(page).load(PDF_NOTE);
  const large = editor.locator(".note-file-large");
  await expect(large.locator(".file-name")).toHaveText("report.pdf");
  await expect(large.locator(".file-meta")).toHaveText(`PDF · ${REPORT_SIZE}`);
  const view = await drawn(page);
  expect(await readerLoaded(page)).toBe(true);
  await expect(view.locator(".pdf-page-total")).toHaveText("/ 30");
  // Virtualized: a box for every page, canvases only near the view.
  await expect(view.locator(".pdf-page")).toHaveCount(PAGES);
  expect(await view.locator(".pdf-page canvas").count()).toBeLessThan(PAGES);
  // The canvas is drawn at the page's width, sharp on dense screens.
  const canvas = view.locator('.pdf-page[data-page="1"] canvas');
  expect(
    await canvas.evaluate((element: HTMLCanvasElement) => element.width),
  ).toBeGreaterThan(200);

  // Thumbnails: one button per page; a tap jumps there.
  const rail = await thumbnails(page, view);
  await expect(rail.getByRole("button")).toHaveCount(PAGES);
  await expect(rail.locator(".pdf-thumb canvas").first()).toBeVisible();
  await rail.getByRole("button", { name: "Go to page 12" }).click();
  const number = view.getByLabel("Page number");
  await expect(number).toHaveValue("12");
  await drawn(page, 12);

  // Page jump: type a page; Next and Previous step.
  await number.fill("25");
  await number.press("Enter");
  await expect(number).toHaveValue("25");
  await drawn(page, 25);
  await view.getByRole("button", { name: "Previous page" }).click();
  await expect(number).toHaveValue("24");
  await view.getByRole("button", { name: "Next page" }).click();
  await expect(number).toHaveValue("25");
  // The note's text stays editable below the file.
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await expect(editor.getByText("Notes about it.")).toBeVisible();
});

test("search in the document finds every match and shows each in turn", async ({
  page,
}) => {
  await serve(page);
  await harness(page);
  await api(page).load(PDF_NOTE);
  const view = await drawn(page);
  await view.getByRole("button", { name: "Search in document" }).click();
  const find = view.getByRole("searchbox", { name: "Find in document" });
  await expect(find).toBeFocused();
  await find.fill("NEEDLE");
  const count = view.locator(".pdf-search-count");
  await expect(count).toHaveText("1 of 2");
  await expect(view.getByLabel("Page number")).toHaveValue("3");
  await expect(
    view.locator('.pdf-page[data-page="3"] mark.is-active'),
  ).toHaveText("needle");
  await find.press("Enter");
  await expect(count).toHaveText("2 of 2");
  await expect(view.getByLabel("Page number")).toHaveValue("20");
  await expect(
    view.locator('.pdf-page[data-page="20"] mark.is-active'),
  ).toHaveText("needle");
  await view.getByRole("button", { name: "Previous match" }).click();
  await expect(count).toHaveText("1 of 2");
  await find.fill("no such words");
  await expect(count).toHaveText("No results");
  // Escape closes the search; typing never reached the note.
  await find.press("Escape");
  await expect(find).toHaveCount(0);
  expect(await blocks(page)).toEqual([
    "report.pdf",
    "file:report.pdf",
    "Notes about it.",
  ]);
});

test("text on a PDF page can be selected; the note's selection and text are untouched", async ({
  page,
}) => {
  await serve(page);
  await harness(page);
  await api(page).load(PDF_NOTE);
  const view = await drawn(page);
  const line = view.locator('.pdf-page[data-page="1"] .pdf-text span').first();
  const box = (await line.boundingBox())!;
  // The run covers the drawn line.
  expect(box.width).toBeGreaterThan(50);
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  const selected = await page.evaluate(
    () => window.getSelection()?.toString() ?? "",
  );
  expect(selected).toContain("Page 1 head");
  // The selection is the reader's: the note's text is unchanged.
  await page.keyboard.type("x");
  expect(await blocks(page)).toEqual([
    "report.pdf",
    "file:report.pdf",
    "Notes about it.",
  ]);
});

test("a PDF that cannot be opened offers Download to view", async ({
  page,
}) => {
  const broken = Buffer.from("%PDF-1.7\nthis is not a document\n");
  await serve(page, { pdf: broken });
  const editor = await harness(page);
  await api(page).load(PDF_NOTE);
  const failed = editor.locator(".pdf-reader-error");
  await expect(failed).toContainText("This PDF could not be opened here.");
  const download = page.waitForEvent("download");
  await failed.getByRole("button", { name: "Download to view" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("report.pdf");
  expect((await readFile(await file.path())).equals(broken)).toBe(true);
});

test("a file note's picture is fitted to the width, without resize controls", async ({
  page,
}) => {
  await serve(page);
  const editor = await harness(page);
  await api(page).load(
    doc(paragraph("title", "harbour.png"), imageBlock, paragraph("n", "")),
  );
  const view = editor.locator(".note-image.is-file-note");
  const picture = view.locator("img");
  await expect(picture).toBeVisible();
  // 40 pixels wide, with a saved width of 120: shown at the column's width.
  const column = (await editor.boundingBox())!.width;
  await expect
    .poll(async () => (await picture.boundingBox())!.width)
    .toBeGreaterThan(Math.min(column - 40, 300));
  await picture.click();
  await expect(view).toHaveClass(/ProseMirror-selectednode/);
  await expect(view.locator(".image-grip")).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Picture size" })).toHaveCount(
    0,
  );
  await picture.click();
  await expect(
    page.getByRole("dialog", { name: "Picture: harbour.png" }),
  ).toBeVisible();
});

test("any other file shows large with its type, size and Download", async ({
  page,
}) => {
  await serve(page);
  const editor = await harness(page);
  await api(page).load(doc(paragraph("title", "Archive"), zipBlock));
  const large = editor.locator(".note-file-large");
  await expect(large.locator(".file-name")).toHaveText("archive.zip");
  await expect(large.locator(".file-meta")).toHaveText("ZIP · 2.4 MB");
  await expect(large.locator("svg").first()).toBeVisible();
  await expect(large.locator(".pdf-reader, .file-reader-stage")).toHaveCount(0);
  const download = page.waitForEvent("download");
  await large.getByRole("button", { name: "Download: archive.zip" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("archive.zip");
  expect((await readFile(await file.path())).equals(ARCHIVE)).toBe(true);
});

test("only a title line, one file and text make a file note; renaming is editing the first line", async ({
  page,
}) => {
  await serve(page);
  const editor = await harness(page);
  const large = editor.locator(".note-file-large");
  const chip = editor.locator(".note-file .file-chip");
  // Text before the file, or a second file: ordinary chips.
  await api(page).load(CHIP_NOTE);
  await expect(chip).toHaveCount(1);
  await expect(large).toHaveCount(0);
  await api(page).load(
    doc(paragraph("title", "Two"), zipBlock, pdfBlock("second")),
  );
  await expect(chip).toHaveCount(2);
  await expect(large).toHaveCount(0);
  // Deleting the second file makes it a file note.
  await chip.nth(1).click();
  await page.keyboard.press("Backspace");
  await expect(large).toHaveCount(1);
  await expect(chip).toHaveCount(0);
  // Renaming: the first line is edited like any text; the file keeps its name.
  // At the line's start: with the phone's user agent, ProseMirror leaves a
  // click next to a selected block to Chromium, which keeps the block
  // selected (an emulation quirk; the iPhone check covers real taps).
  await editor.getByText("Two", { exact: true }).click({
    position: { x: 4, y: 8 },
  });
  await expect(editor.locator(".ProseMirror-selectednode")).toHaveCount(0);
  await page.keyboard.press("End");
  await page.keyboard.type(" (renamed)");
  await expect(large).toHaveCount(1);
  await expect(large.locator(".file-name")).toHaveText("archive.zip");
  expect(await blocks(page)).toEqual(["Two (renamed)", "file:archive.zip"]);
  // Text written below the file keeps it a file note: a tap on the file
  // selects it, and Enter starts a line after it.
  await large.locator(".file-name").click();
  await expect(large).toHaveClass(/ProseMirror-selectednode/);
  await page.keyboard.press("Enter");
  await page.keyboard.type("A line below.");
  await expect(large).toHaveCount(1);
  expect(await blocks(page)).toEqual([
    "Two (renamed)",
    "file:archive.zip",
    "A line below.",
  ]);
  // With files off the note renders as before B4: no large view.
  await api(page).setFiles(false);
  await expect(large).toHaveCount(0);
  await expect(editor.locator("div[data-object-id]")).toHaveText("archive.zip");
});

test("a PDF chip opens the reader full screen; Escape and × close it", async ({
  page,
}) => {
  await serve(page);
  const editor = await harness(page);
  await api(page).load(CHIP_NOTE);
  const chip = editor.locator(".file-chip");
  await expect(chip).toHaveAttribute(
    "aria-label",
    `Open report.pdf, PDF, ${REPORT_SIZE}`,
  );
  let downloads = 0;
  page.on("download", () => downloads++);
  await openChip(chip);
  const dialog = page.getByRole("dialog", { name: "PDF: report.pdf" });
  await expect(dialog).toBeVisible();
  await drawn(dialog);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  // Again; × closes it too. Opening a PDF is not a download.
  await openChip(chip);
  await drawn(dialog);
  await dialog.getByRole("button", { name: "Close PDF" }).click();
  await expect(dialog).toHaveCount(0);
  expect(downloads).toBe(0);
  // Its Download downloads the file's bytes.
  await openChip(chip);
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download report.pdf" }).click();
  expect((await readFile(await (await download).path())).equals(REPORT)).toBe(
    true,
  );
  await page.keyboard.press("Escape");
  // A file note's Full screen opens the same reader.
  await api(page).load(PDF_NOTE);
  await drawn(page);
  await editor
    .getByRole("button", { name: "Open in full screen: report.pdf" })
    .click();
  await drawn(dialog);
});

// ---- Every B3 fence applies to the reader ----

type Fence = "unavailable" | "files off" | "session change" | "cache clear";
const FENCES: Fence[] = [
  "unavailable",
  "files off",
  "session change",
  "cache clear",
];

/**
 * Cause `fence` and report, in the same task (before React or anything
 * else runs), what of the reader and the full-screen dialog is on the page.
 */
const fenceNow = (page: Page, fence: Fence) =>
  page.evaluate((fence) => {
    const h = (window as unknown as HarnessWindow).__attachments;
    if (fence === "unavailable") h.setObjects([]);
    else if (fence === "files off") h.setFiles(false);
    else if (fence === "session change") h.nextSession();
    else h.clearCache();
    return {
      canvases: document.querySelectorAll(".pdf-canvas, .pdf-text span").length,
      readers: document.querySelectorAll(".pdf-reader").length,
      dialogs: document.querySelectorAll("dialog.pdf-dialog").length,
    };
  }, fence);

for (const fence of FENCES)
  test(`the inline reader leaves the page at once: ${fence}`, async ({
    page,
  }) => {
    const { reads } = await serve(page);
    const editor = await harness(page);
    await api(page).setObjects([PDF_ID]);
    await api(page).load(PDF_NOTE);
    await drawn(page);
    expect(await fenceNow(page, fence)).toEqual({
      canvases: 0,
      readers: 0,
      dialogs: 0,
    });
    const large = editor.locator(".note-file-large");
    if (fence === "unavailable") {
      await expect(large.locator(".file-meta")).toHaveText(
        "Attachment unavailable",
      );
      await expect(large.locator(".file-reader-placeholder")).toHaveText(
        "Attachment unavailable",
      );
      // Listed again, it loads again.
      await api(page).setObjects([PDF_ID]);
      await drawn(page);
    } else if (fence === "files off") {
      // As before B4: the file block's name, nothing read.
      await expect(large).toHaveCount(0);
      await expect(editor.locator("div[data-object-id]")).toHaveText(
        "report.pdf",
      );
      expect(await cachedObjects(page)).toEqual([]);
    } else {
      // A clear, or the next session generation with the note still open
      // (the app opens a new editor; this harness keeps its own): nothing
      // from before is shown; the PDF is read again, then shown again.
      await drawn(page);
      expect(reads.filter((id) => id === PDF_ID)).toHaveLength(2);
    }
  });

for (const fence of [...FENCES, "the note closes"] as const)
  test(`the full-screen reader closes at once: ${fence}`, async ({ page }) => {
    await serve(page);
    const editor = await harness(page);
    await api(page).setObjects([PDF_ID]);
    await api(page).load(CHIP_NOTE);
    await openChip(editor.locator(".file-chip"));
    const dialog = page.getByRole("dialog", { name: "PDF: report.pdf" });
    await drawn(dialog);
    if (fence === "the note closes") {
      await api(page).close();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator(".pdf-canvas")).toHaveCount(0);
      return;
    }
    expect(await fenceNow(page, fence)).toEqual({
      canvases: 0,
      readers: 0,
      dialogs: 0,
    });
    // It stays closed: opening again is a new activation.
    await page.waitForTimeout(300);
    await expect(dialog).toHaveCount(0);
  });

// ---- Review round 5 of B3, fixed here because the reader uses these paths ----

test("R5-1: a download held when its object becomes unavailable delivers nothing, whatever the list says later", async ({
  page,
}) => {
  const downloads: string[] = [];
  page.on("download", (download) =>
    downloads.push(download.suggestedFilename()),
  );
  for (const later of [null, [ZIP_ID]] as const) {
    downloads.length = 0;
    const { release } = await serve(page, { hold: ZIP_ID });
    const editor = await harness(page);
    await api(page).setObjects([ZIP_ID]);
    await api(page).load(
      doc(paragraph("title", "Album"), paragraph("a", "Text."), zipBlock),
    );
    const chip = editor.locator(".file-chip");
    await openChip(chip);
    await expect(chip.locator(".file-meta")).toHaveText("Downloading…");
    // The server stops listing it, then forgets (null) or lists it again.
    await api(page).setObjects([]);
    await api(page).setObjects(later === null ? null : [...later]);
    release();
    await page.waitForTimeout(800);
    expect(downloads).toEqual([]);
    expect(await cachedObjects(page)).not.toContain(ZIP_ID);
    if (later !== null) {
      // Listed again: a new tap downloads.
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await serve(page);
      await openChip(chip);
      await expect.poll(() => downloads).toEqual(["archive.zip"]);
    }
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});

test("R5-1: a full-screen PDF held when its object becomes unavailable closes and keeps nothing", async ({
  page,
}) => {
  const { release } = await serve(page, { hold: PDF_ID });
  const editor = await harness(page);
  await api(page).setObjects([PDF_ID]);
  await api(page).load(CHIP_NOTE);
  await openChip(editor.locator(".file-chip"));
  const dialog = page.getByRole("dialog", { name: "PDF: report.pdf" });
  await expect(dialog.getByRole("status")).toHaveText("Opening…");
  await api(page).setObjects([]);
  await expect(dialog).toHaveCount(0);
  await api(page).setObjects(null);
  release();
  await page.waitForTimeout(800);
  await expect(dialog).toHaveCount(0);
  expect(await cachedObjects(page)).not.toContain(PDF_ID);
});

test("R5-2: an earlier admission that answers after a Retry landed is released", async ({
  page,
}) => {
  const editor = await harness(page);
  await uploads(page);
  await api(page).delay(2_000);
  await editor.getByText("First line.", { exact: true }).click();
  await editor.press("End");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Add file" }).first().click();
  await (
    await chooser
  ).setFiles({ name: "photo.png", mimeType: "image/png", buffer: PHOTO });
  await expect.poll(async () => (await api(page).calls()).length).toBe(1);
  // Admission A is held; the session moves on; Retry asks again (B).
  await api(page).nextSession();
  const upload = page.getByRole("group", { name: "Upload of photo.png" });
  await expect(upload.getByRole("status")).toHaveText(
    "The session changed. Retry to upload this file.",
  );
  await api(page).delay(0);
  await upload.getByRole("button", { name: "Retry" }).click();
  await expect(upload).toHaveCount(0);
  const calls = await api(page).calls();
  const [first, second] = calls;
  expect(await blocks(page)).toContain(`image:attachment:${second!.objectId}`);
  // A answers after B landed: released through its service; B is kept.
  await expect
    .poll(async () => (await api(page).calls()).map((call) => call.name), {
      timeout: 5_000,
    })
    .toEqual(["createUpload", "createUpload", "cancelUpload"]);
  const released = (await api(page).calls())[2]!;
  expect(released.args.objectId).toBe(first!.objectId);
  expect(released.args.objectId).not.toBe(second!.objectId);
});

// ---- A file note made from the list: its editor uploads the file ----

test("a new file note uploads its file after the title and shows it large", async ({
  page,
}) => {
  const { reads } = await serve(page);
  const put = await uploads(page);
  const editor = await harness(page);
  await api(page).fileNote("harbour.png", "harbour.png", "image/png", PHOTO);
  await expect.poll(() => api(page).taken()).toBe(true);
  const picture = editor.locator(".note-image.is-file-note img");
  await expect(picture).toBeVisible();
  expect(await blocks(page)).toEqual([
    "harbour.png",
    `image:attachment:${put.seen[0]}`,
  ]);
  // The PDF lands as a file block; the reader shows the uploaded bytes.
  await api(page).fileNote(
    "report.pdf",
    "report.pdf",
    "application/pdf",
    REPORT,
  );
  await expect.poll(() => api(page).taken()).toBe(true);
  await drawn(page);
  expect(await blocks(page)).toEqual(["report.pdf", "file:report.pdf"]);
  // Shown from the upload's own bytes: nothing was read back.
  expect(reads).toEqual([]);
  // The title stays the first line and stays editable.
  await expect(editor.locator("p").first()).toHaveText("report.pdf");
  await expect(editor).toHaveAttribute("contenteditable", "true");
});

test("a new file note's upload: a failure keeps Retry and Remove; Cancel leaves the note with its title", async ({
  page,
}) => {
  const put = await uploads(page);
  await harness(page);
  put.respond(500);
  await api(page).fileNote(
    "report.pdf",
    "report.pdf",
    "application/pdf",
    REPORT,
  );
  const upload = page.getByRole("group", { name: "Upload of report.pdf" });
  await expect(upload.getByRole("status")).toHaveText(
    "The upload failed. Check the connection and retry.",
  );
  await expect(upload.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(upload.getByRole("button", { name: "Remove" })).toBeVisible();
  put.respond(200);
  await upload.getByRole("button", { name: "Retry" }).click();
  await expect(upload).toHaveCount(0);
  expect(await blocks(page)).toEqual(["report.pdf", "file:report.pdf"]);

  // Cancel while it is sent: the note keeps its title, nothing else.
  put.hold();
  await api(page).fileNote(
    "archive.zip",
    "archive.zip",
    "application/zip",
    ARCHIVE,
  );
  const second = page.getByRole("group", { name: "Upload of archive.zip" });
  await expect(second.getByRole("status")).toHaveText(/Uploading/);
  await second.getByRole("button", { name: "Cancel" }).click();
  await expect(second).toHaveCount(0);
  put.release();
  await page.waitForTimeout(300);
  expect(await blocks(page)).toEqual(["archive.zip"]);
  expect((await api(page).calls()).at(-1)!.name).toBe("cancelUpload");
});

test("a new file note's file waits for a note that can take files", async ({
  page,
}) => {
  await uploads(page);
  const editor = await harness(page, false);
  // Files off: nothing is taken or sent.
  await api(page).fileNote("harbour.png", "harbour.png", "image/png", PHOTO);
  await page.waitForTimeout(300);
  expect(await api(page).taken()).toBe(false);
  expect(await api(page).calls()).toEqual([]);
  // Read-only: still waits.
  await api(page).setEditable(false);
  await api(page).setFiles(true);
  await page.waitForTimeout(300);
  expect(await api(page).taken()).toBe(false);
  // Editable with files on: it uploads, once.
  await api(page).setEditable(true);
  await expect(editor.locator(".note-image.is-file-note img")).toBeVisible();
  expect(await api(page).taken()).toBe(true);
  expect(
    (await api(page).calls()).filter((call) => call.name === "createUpload"),
  ).toHaveLength(1);
});

// ---- The note list (fixture mode: the real app, no server) ----

/** Cache a note for the fixture account, as the live layer would. */
const cacheNote = (
  page: Page,
  id: string,
  value: unknown,
  text: string,
  at: number,
) =>
  page.evaluate(
    async ({ id, value, text, at }) => {
      const harness = (
        window as unknown as {
          __notesHarness: {
            store: import("../../apps/notes/src/cache").NotesStore;
          };
        }
      ).__notesHarness;
      const document = JSON.stringify(value);
      const fence = await harness.store.captureFence("fixture-account");
      await harness.store.cacheAccepted(
        {
          accountId: "fixture-account",
          id,
          document,
          text,
        },
        at,
        fence,
      );
    },
    { id, value, text, at },
  );

const setAppFiles = (page: Page, on: boolean) =>
  page.evaluate(async (on) => {
    const url = "/src/file-capability.ts";
    const { setFileWrites } = (await import(
      /* @vite-ignore */ url
    )) as typeof import("../../apps/notes/src/file-capability");
    setFileWrites(on);
  }, on);

async function fixtureList(page: Page) {
  await page.goto("/?fixture=seed&session=ready");
  await expect(
    page.getByRole("button", { name: /Welcome to your notes/ }),
  ).toBeVisible();
  // Their text as the app derives it: a file's name is text (B2).
  await cacheNote(
    page,
    "fixture-pdf",
    PDF_NOTE,
    "report.pdf\nreport.pdf\nNotes about it.",
    1_800_000_000_000,
  );
  await cacheNote(
    page,
    "fixture-photo",
    doc(paragraph("t", "harbour.png"), imageBlock),
    "harbour.png\nharbour.png",
    1_800_000_000_001,
  );
  const pdfRow = page.getByRole("button", { name: /^report\.pdf/ });
  const photoRow = page.getByRole("button", { name: /^harbour\.png/ });
  await expect(pdfRow).toBeVisible();
  await expect(photoRow).toBeVisible();
  return { pdfRow, photoRow };
}

/** Drop a file on the note list; whether the app took the drag and the drop. */
const dropOnList = (page: Page) =>
  page.evaluate(() => {
    const list = document.querySelector(".note-list")!;
    const data = new DataTransfer();
    data.items.add(new File(["hello"], "hello.txt", { type: "text/plain" }));
    const over = new DragEvent("dragover", {
      dataTransfer: data,
      bubbles: true,
      cancelable: true,
    });
    list.dispatchEvent(over);
    const drop = new DragEvent("drop", {
      dataTransfer: data,
      bubbles: true,
      cancelable: true,
    });
    list.dispatchEvent(drop);
    return [over.defaultPrevented, drop.defaultPrevented];
  });

test("with files off, the list offers no Upload, leaves dropped files alone and lists file notes as before", async ({
  page,
}, info) => {
  const { pdfRow } = await fixtureList(page);
  await expect(pdfRow).not.toHaveClass(/has-file/);
  await expect(page.locator(".row-file, .row-file-visual")).toHaveCount(0);
  await expect(pdfRow.locator(".row-preview")).toHaveText(
    "report.pdf Notes about it.",
  );
  await expect(page.getByRole("button", { name: "Upload a file" })).toHaveCount(
    0,
  );
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  if (!info.project.name.includes("mobile"))
    expect(await dropOnList(page)).toEqual([false, false]);
  await expect(page.locator(".note-list")).not.toHaveClass(/file-drop/);
});

test("with files on, file notes list with a type icon and their type and size; a picture shows from memory, and a clear takes it away", async ({
  page,
}, info) => {
  const { pdfRow, photoRow } = await fixtureList(page);
  await setAppFiles(page, true);
  await expect(pdfRow).toHaveClass(/has-file/);
  await expect(pdfRow.locator(".row-file")).toHaveText(`PDF · ${REPORT_SIZE}`);
  await expect(pdfRow.locator(".row-preview")).toHaveText(
    new RegExp(`^PDF · ${REPORT_SIZE}\\s*Notes about it\\.$`),
  );
  await expect(pdfRow.locator(".row-file-visual svg")).toBeVisible();
  await expect(photoRow.locator(".row-file")).toHaveText("PNG");
  await expect(photoRow.locator(".row-file-visual svg")).toBeVisible();
  // The row's name still starts with the title.
  await expect(
    page.getByRole("button", { name: /^Welcome to your notes/ }),
  ).not.toHaveClass(/has-file/);
  // Bytes this page holds (as showing the picture keeps them) show as the
  // thumbnail when the list next renders; nothing is read for it.
  await page.evaluate(
    async ({ objectId, bytes }) => {
      const url = "/src/attachment-cache.ts";
      const { attachmentCache } = (await import(
        /* @vite-ignore */ url
      )) as typeof import("../../apps/notes/src/attachment-cache");
      attachmentCache.store(
        attachmentCache.current(),
        objectId,
        new Blob([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))], {
          type: "image/png",
        }),
      );
    },
    { objectId: IMAGE_ID, bytes: PHOTO.toString("base64") },
  );
  await page.getByRole("searchbox").fill("harb");
  const thumbnail = photoRow.locator(".row-file-visual img");
  await expect(thumbnail).toBeVisible();
  expect(
    await thumbnail.evaluate((img: HTMLImageElement) => img.naturalWidth),
  ).toBe(40);
  // A clear takes it off the page at once.
  const left = await page.evaluate(async () => {
    const url = "/src/attachment-cache.ts";
    const { attachmentCache } = (await import(
      /* @vite-ignore */ url
    )) as typeof import("../../apps/notes/src/attachment-cache");
    attachmentCache.clear();
    return document.querySelector(".row-file-visual img")?.getAttribute("src");
  });
  expect(left ?? null).toBeNull();
  await expect(photoRow.locator(".row-file-visual svg")).toBeVisible();
  // Without the server, still no Upload and no drop (nothing can write).
  await expect(page.getByRole("button", { name: "Upload a file" })).toHaveCount(
    0,
  );
  if (!info.project.name.includes("mobile"))
    expect(await dropOnList(page)).toEqual([false, false]);
  // Files off again: as before.
  await page.getByRole("searchbox").fill("");
  await setAppFiles(page, false);
  await expect(page.locator(".row-file, .row-file-visual")).toHaveCount(0);
});
