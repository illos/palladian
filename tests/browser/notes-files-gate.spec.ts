import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Review round 4 of B1+B2 (R4-1): until the server says files are on, pasted
 * content keeps no file blocks, attachment images or image widths, so an edit
 * is never refused and typing carries on. Fixture mode has no server, so
 * files are off, as for a deployment with FILES_WRITES_ENABLED unset.
 */

const OBJECT = "k57a1b2c3d4e5f6g7h8j9k0m1n2p3q4r";
/**
 * An attachment image in the editor. Since B3 a node view draws it (the
 * picture loads through the Worker), so it is found by its source rather
 * than by an <img> showing `attachment:`.
 */
const ATTACHMENT_IMAGE = '.note-image[data-src^="attachment:"]';

async function newNote(page: Page) {
  await page.goto("/?fixture=seed&session=stall");
  await expect(
    page.getByRole("button", { name: /Welcome to your notes/ }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "New note", exact: true })
    .first()
    .click();
  const editor = page.getByRole("textbox", { name: "Note content" });
  await expect(editor).toHaveClass(/ProseMirror/);
  await expect(editor).toHaveAttribute("contenteditable", "true");
  return editor;
}

async function markdownLoaded(page: Page) {
  await page.waitForFunction(() =>
    performance
      .getEntriesByType("resource")
      .some((entry) => entry.name.includes("notes-core/src/markdown.ts")),
  );
}

async function paste(editor: Locator, data: Record<string, string>) {
  await editor.evaluate((element, entries) => {
    const transfer = new DataTransfer();
    for (const [type, value] of Object.entries(entries))
      transfer.setData(type, value);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, data);
}

test("with files off, pasted Markdown and HTML keep no file features; typing continues", async ({
  page,
}) => {
  const editor = await newNote(page);
  await markdownLoaded(page);
  await editor.click();
  await editor.pressSequentially("Gate");
  await editor.press("Enter");
  await paste(editor, {
    "text/plain": [
      "# Files",
      "![web](https://example.com/w.png){width=300}",
      `![photo](attachment:${OBJECT})`,
      `[report.pdf](attachment:${OBJECT}){type=application/pdf size=3}`,
    ].join("\n\n"),
  });
  await expect(editor.locator("h1")).toHaveText("Files");
  await expect(editor).toContainText("photo");
  await expect(editor).toContainText("report.pdf");
  // The web image stays, without its width; nothing else came in.
  await expect(editor.locator("img")).toHaveCount(1);
  await expect(editor.locator("img")).not.toHaveAttribute("width");
  await expect(editor.locator("[data-object-id]")).toHaveCount(0);
  await expect(editor.locator(ATTACHMENT_IMAGE)).toHaveCount(0);

  // A Palladian copy (HTML) of a file block and a sized attachment image.
  await editor.press("End");
  await paste(editor, {
    "text/plain": "copied",
    "text/html": `<div data-pm-slice="0 0 []"><div data-object-id="${OBJECT}" data-name="copied.pdf" data-mime-type="application/pdf" data-size="3">copied.pdf</div><img src="attachment:${OBJECT}" alt="copied photo" width="200"></div>`,
  });
  await expect(editor).toContainText("copied.pdf");
  await expect(editor).toContainText("copied photo");
  await expect(editor.locator("[data-object-id]")).toHaveCount(0);
  await expect(editor.locator(ATTACHMENT_IMAGE)).toHaveCount(0);

  // Typing carries on.
  await editor.press("End");
  await editor.press("Enter");
  await editor.pressSequentially("still typing");
  await expect(editor).toContainText("still typing");
  await expect(editor).toHaveAttribute("contenteditable", "true");
});

/**
 * Turn files on or off in the running app, as `files.capabilities` would.
 * Fixture mode has no server; the dev server serves the app's own module, so
 * this sets the same state the editor reads.
 */
async function setFiles(page: Page, on: boolean) {
  await page.evaluate(async (value) => {
    const url = "/src/file-capability.ts";
    const module = (await import(/* @vite-ignore */ url)) as {
      setFileWrites(value: boolean): void;
    };
    module.setFileWrites(value);
  }, on);
}

/** Dispatch a copy or cut event; returns what the editor put on the clipboard. */
async function clip(editor: Locator, type: "copy" | "cut") {
  return await editor.evaluate((element, kind) => {
    const transfer = new DataTransfer();
    const event = new ClipboardEvent(kind, {
      clipboardData: transfer,
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(event);
    return {
      prevented: event.defaultPrevented,
      html: transfer.getData("text/html"),
      text: transfer.getData("text/plain"),
    };
  }, type);
}

async function withAttachments(page: Page) {
  const editor = await newNote(page);
  await markdownLoaded(page);
  await setFiles(page, true);
  await editor.click();
  await editor.pressSequentially("Album");
  await editor.press("Enter");
  await paste(editor, {
    "text/plain": [
      `![photo](attachment:${OBJECT})`,
      `[report.pdf](attachment:${OBJECT}){type=application/pdf size=3}`,
      "![web](https://example.com/w.png){width=300}",
      "End",
    ].join("\n\n"),
  });
  await expect(editor.locator("[data-object-id]")).toHaveCount(1);
  await expect(editor.locator(ATTACHMENT_IMAGE)).toHaveCount(1);
  await expect(editor.locator('img[width="300"]')).toHaveCount(1);
  return editor;
}

/**
 * Select a block node by clicking it, as a person would: on its name or
 * picture (ProseMirror ignores clicks on the empty part of a file block).
 */
async function selectNode(target: Locator) {
  await target.click({ position: { x: 10, y: 10 } });
  await expect(target).toHaveClass(/ProseMirror-selectednode/);
}

/** Paste at the end of the last paragraph. */
async function pasteAtEnd(editor: Locator, data: Record<string, string>) {
  await editor.locator("p").last().click();
  await editor.press("End");
  // The click replaces a selected block once ProseMirror reads the new
  // caret; pasting before that would replace the block instead.
  await expect(editor.locator(".ProseMirror-selectednode")).toHaveCount(0);
  await paste(editor, data);
}

test("R5-2: with files off, cutting an attachment is refused with a message; deleting works, undo explains", async ({
  page,
}) => {
  const editor = await withAttachments(page);
  await setFiles(page, false);
  const fileBlock = editor.locator("[data-object-id]");
  await selectNode(fileBlock);
  const cut = await clip(editor, "cut");
  expect(cut.prevented).toBe(true);
  await expect(fileBlock).toHaveCount(1);
  await expect(page.locator(".link-notice")).toHaveText(
    "Files can't be moved this way yet. Copy, or drag within the note, instead.",
  );
  // An attachment image too.
  await selectNode(editor.locator(ATTACHMENT_IMAGE));
  expect((await clip(editor, "cut")).prevented).toBe(true);
  await expect(editor.locator(ATTACHMENT_IMAGE)).toHaveCount(1);
  // Deleting is deliberate and works; undoing it would bring the file back.
  await selectNode(fileBlock);
  await editor.press("Backspace");
  await expect(fileBlock).toHaveCount(0);
  await page.waitForTimeout(600); // a separate undo step
  await editor.press("ControlOrMeta+z");
  await expect(page.locator(".link-notice")).toHaveText(
    "Undo can't bring back removed files or image sizes yet.",
  );
  await expect(fileBlock).toHaveCount(0);
  // Typing carries on (in the title, clear of the message). Deleting the
  // file left the image after it selected; typing before ProseMirror reads
  // the click's caret would replace that image instead (as in pasteAtEnd).
  await editor.locator("p").first().click();
  await expect(editor.locator(".ProseMirror-selectednode")).toHaveCount(0);
  await editor.press("End");
  await editor.pressSequentially(" typed");
  await expect(editor).toContainText("Album typed");
  await expect(editor.locator("p").first()).toHaveText("Album typed");
});

test("R5-2: with files off, copy then paste keeps the note's own attachment", async ({
  page,
}) => {
  const editor = await withAttachments(page);
  await setFiles(page, false);
  await selectNode(editor.locator("[data-object-id]"));
  const copied = await clip(editor, "copy");
  expect(copied.html).toContain("data-object-id");
  await pasteAtEnd(editor, {
    "text/html": copied.html,
    "text/plain": copied.text,
  });
  await expect(editor.locator("[data-object-id]")).toHaveCount(2);
});

test("R5-2: with files on, cut and paste keep the attachment", async ({
  page,
}) => {
  const editor = await withAttachments(page);
  await selectNode(editor.locator("[data-object-id]"));
  const cut = await clip(editor, "cut");
  expect(cut.html).toContain("data-object-id");
  await expect(editor.locator("[data-object-id]")).toHaveCount(0);
  await pasteAtEnd(editor, { "text/html": cut.html, "text/plain": cut.text });
  await expect(editor.locator("[data-object-id]")).toHaveCount(1);
  await expect(page.locator(".link-notice")).toHaveCount(0);
});

test("R5-3: an image's width survives the app's own HTML copy and paste", async ({
  page,
}) => {
  const editor = await withAttachments(page);
  const sized = editor.locator('img[src="https://example.com/w.png"]');
  await selectNode(sized);
  const copied = await clip(editor, "copy");
  expect(copied.html).toContain('data-width="300"');
  // Files on: the copy keeps its width.
  await pasteAtEnd(editor, {
    "text/html": copied.html,
    "text/plain": copied.text,
  });
  await expect(sized).toHaveCount(2);
  await expect(editor.locator('img[width="300"]')).toHaveCount(2);
  // Files off, same note: the note already uses that width, so it stays.
  await setFiles(page, false);
  await pasteAtEnd(editor, {
    "text/html": copied.html,
    "text/plain": copied.text,
  });
  await expect(editor.locator('img[width="300"]')).toHaveCount(3);
  // Files off, another note: the width is new there and is dropped. (The
  // reload starts the app again with files off.)
  const other = await newNote(page);
  await expect(other).not.toContainText("Album");
  await other.click();
  await other.pressSequentially("Other");
  await other.press("Enter");
  await paste(other, { "text/html": copied.html, "text/plain": copied.text });
  await expect(
    other.locator('img[src="https://example.com/w.png"]'),
  ).toHaveCount(1);
  await expect(other.locator("img[width]")).toHaveCount(0);
});
