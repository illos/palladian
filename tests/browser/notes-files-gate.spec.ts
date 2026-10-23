import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Review round 4 of B1+B2 (R4-1): until the server says files are on, pasted
 * content keeps no file blocks, attachment images or image widths, so an edit
 * is never refused and typing carries on. Fixture mode has no server, so
 * files are off, as for a deployment with FILES_WRITES_ENABLED unset.
 */

const OBJECT = "k57a1b2c3d4e5f6g7h8j9k0m1n2p3q4r";

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
  await expect(editor.locator('img[src^="attachment:"]')).toHaveCount(0);

  // A Palladian copy (HTML) of a file block and a sized attachment image.
  await editor.press("End");
  await paste(editor, {
    "text/plain": "copied",
    "text/html": `<div data-pm-slice="0 0 []"><div data-object-id="${OBJECT}" data-name="copied.pdf" data-mime-type="application/pdf" data-size="3">copied.pdf</div><img src="attachment:${OBJECT}" alt="copied photo" width="200"></div>`,
  });
  await expect(editor).toContainText("copied.pdf");
  await expect(editor).toContainText("copied photo");
  await expect(editor.locator("[data-object-id]")).toHaveCount(0);
  await expect(editor.locator('img[src^="attachment:"]')).toHaveCount(0);

  // Typing carries on.
  await editor.press("End");
  await editor.press("Enter");
  await editor.pressSequentially("still typing");
  await expect(editor).toContainText("still typing");
  await expect(editor).toHaveAttribute("contenteditable", "true");
});
