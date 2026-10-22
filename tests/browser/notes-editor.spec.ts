import { expect, test, type Locator, type Page } from "@playwright/test";

/** A new local draft in fixture mode: a rich, editable ProseMirror editor. */
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
/** The key ProseMirror reads as Mod for this page's platform. */
function modKey(page: Page) {
  return page.evaluate(() =>
    /Mac|iP(hone|[oa]d)/.test(navigator.platform) ? "Meta" : "Control",
  );
}
function isMobile(name: string) {
  return name.includes("mobile");
}
/** Click a formatting button; phones open its tool group first. */
async function tool(page: Page, mobile: boolean, group: string, name: string) {
  if (mobile) {
    const toggle = page.getByRole("button", {
      name: `${group} tools`,
      exact: true,
    });
    if ((await toggle.getAttribute("aria-expanded")) !== "true")
      await toggle.click();
  }
  await page.getByRole("button", { name, exact: true }).click();
}
/** Record window.open calls instead of opening tabs. */
async function captureOpens(page: Page) {
  await page.evaluate(() => {
    const opened: unknown[][] = [];
    (window as unknown as { opened: unknown[][] }).opened = opened;
    window.open = (...args: unknown[]) => {
      opened.push(args);
      return null;
    };
  });
}
function opened(page: Page) {
  return page.evaluate(
    () => (window as unknown as { opened: unknown[][] }).opened,
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
/**
 * The browser reports caret moves asynchronously (selectionchange); let the
 * editor read one before the next key, as a person's typing would.
 */
function settle(page: Page) {
  return page.waitForTimeout(100);
}
/** Paste and copy use the Markdown code, which loads after the editor. */
async function markdownLoaded(page: Page) {
  await page.waitForFunction(() =>
    performance
      .getEntriesByType("resource")
      .some((entry) => entry.name.includes("notes-core/src/markdown.ts")),
  );
}

test("Markdown shortcuts, divider, line break and Backspace to undo a shortcut", async ({
  page,
}) => {
  const editor = await newNote(page);
  const mod = await modKey(page);
  await editor.pressSequentially("Title");
  await editor.press("Enter");
  await editor.pressSequentially("## ");
  await expect(editor.locator("h2")).toHaveCount(1);
  await editor.press("Backspace");
  await expect(editor.locator("h2")).toHaveCount(0);
  await expect(editor.locator("p").nth(1)).toHaveText("## ");
  for (let i = 0; i < 3; i++) await editor.press("Backspace");
  await editor.pressSequentially("---");
  await expect(editor.locator("hr")).toHaveCount(1);
  await editor.pressSequentially("After the rule");
  await expect(editor.locator("hr + p")).toHaveText("After the rule");
  await editor.press("Shift+Enter");
  await editor.pressSequentially("second line");
  await expect(
    editor.locator("hr + p br:not(.ProseMirror-trailingBreak)"),
  ).toHaveCount(1);
  await editor.press(`${mod}+Alt+2`);
  await expect(editor.locator("h2")).toContainText("After the rule");
  await editor.press(`${mod}+Alt+2`);
  await expect(editor.locator("h2")).toHaveCount(0);
  await editor.press(`${mod}+Shift+Period`);
  await expect(editor.locator("blockquote")).toContainText("After the rule");
  await expect(
    page.getByText("Draft saved on this device — not saved to server"),
  ).toBeVisible();
});

test("style buttons toggle back to body; list buttons convert selected lines", async ({
  page,
}, info) => {
  const mobile = isMobile(info.project.name);
  const editor = await newNote(page);
  await editor.pressSequentially("Title");
  await editor.press("Enter");
  await editor.pressSequentially("One");
  await tool(page, mobile, "Style", "Subhead");
  await expect(editor.locator("h3")).toHaveText("One");
  await tool(page, mobile, "Style", "Subhead");
  await expect(editor.locator("h3")).toHaveCount(0);
  await editor.press("End");
  await editor.press("Enter");
  await editor.pressSequentially("Two");
  await editor.press("Shift+ArrowUp");
  await settle(page);
  await tool(page, mobile, "Lists", "Bulleted list");
  await expect(editor.locator("ul:not([data-type]) > li")).toHaveCount(2);
  await tool(page, mobile, "Lists", "Checklist");
  await expect(editor.locator("ul[data-type='tasks'] > li")).toHaveCount(2);
  await expect(editor.locator("ul:not([data-type])")).toHaveCount(0);
  await tool(page, mobile, "Lists", "Checklist");
  await expect(editor.locator("li")).toHaveCount(0);
  await expect(editor.locator("p")).toHaveText(["Title", "One", "Two"]);
  await editor.press("ArrowRight");
  await tool(page, mobile, "Lists", "Divider");
  await expect(editor.locator("hr")).toHaveCount(1);
});

test("the link form: Mod-K on a selection, the toolbar button, validation", async ({
  page,
}, info) => {
  const mobile = isMobile(info.project.name);
  const editor = await newNote(page);
  const mod = await modKey(page);
  await editor.pressSequentially("Read the docs");
  for (let i = 0; i < 4; i++) await editor.press("Shift+ArrowLeft");
  await settle(page);
  await editor.press(`${mod}+k`);
  const text = page.getByRole("textbox", { name: "Link text" });
  const address = page.getByRole("textbox", { name: "Link address" });
  await expect(text).toHaveValue("docs");
  await expect(address).toBeFocused();
  await address.fill("example.com");
  await address.press("Enter");
  await expect(editor.locator("a")).toHaveAttribute(
    "href",
    "https://example.com",
  );
  await expect(editor.locator("a")).toHaveText("docs");
  await expect(text).toHaveCount(0);
  await expect(editor).toBeFocused();

  await editor.press("End");
  await editor.pressSequentially(" and ");
  await tool(page, mobile, "Format", "Link");
  await expect(text).toBeFocused();
  if (mobile) {
    // Phones: 16px fields (no focus zoom), above the keyboard and toolbar.
    await expect(text).toHaveCSS("font-size", "16px");
    await expect(page.locator(".link-form")).toHaveCSS("position", "fixed");
  }
  await text.fill("home");
  await address.fill("not a link");
  await address.press("Enter");
  await expect(page.locator(".link-form").getByRole("alert")).toContainText(
    "web address",
  );
  await address.press("Escape");
  await expect(address).toHaveCount(0);
  await expect(editor.locator("a")).toHaveCount(1);
  await expect(editor).toHaveText("Read the docs and ");
});

test("tapping a link offers Open, Edit and Remove", async ({ page }, info) => {
  const editor = await newNote(page);
  await editor.pressSequentially("Visit example.com ");
  const link = editor.locator("a");
  await expect(link).toHaveAttribute("href", "https://example.com");
  await captureOpens(page);
  await link.click();
  const menu = page.getByRole("toolbar", { name: "Link", exact: true });
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("https://example.com");
  await expect(editor).toBeFocused();
  await menu.getByRole("button", { name: "Open" }).click();
  expect(await opened(page)).toEqual([
    ["https://example.com", "_blank", "noopener"],
  ]);
  await expect(menu).toHaveCount(0);

  await link.click();
  await menu.getByRole("button", { name: "Edit" }).click();
  const text = page.getByRole("textbox", { name: "Link text" });
  await expect(text).toHaveValue("example.com");
  await expect(page.getByRole("textbox", { name: "Link address" })).toHaveValue(
    "https://example.com",
  );
  await text.fill("Example");
  await text.press("Enter");
  await expect(link).toHaveText("Example");

  await link.click();
  await menu.getByRole("button", { name: "Remove" }).click();
  await expect(link).toHaveCount(0);
  await expect(editor).toHaveText("Visit Example ");

  if (!isMobile(info.project.name)) {
    await editor.press("End");
    await editor.pressSequentially("then example.org ");
    const mod = await modKey(page);
    await link.click({ modifiers: [mod === "Meta" ? "Meta" : "Control"] });
    expect((await opened(page)).at(-1)).toEqual([
      "https://example.org",
      "_blank",
      "noopener",
    ]);
    await expect(menu).toHaveCount(0);
  }
});

test("a read-only note opens a tapped link directly", async ({ page }) => {
  await page.goto("/?fixture=seed&session=stall");
  await expect(
    page.getByRole("button", { name: /Welcome to your notes/ }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const modulePath = "/src/cache.ts";
    const module = (await import(
      modulePath
    )) as typeof import("../../apps/notes/src/cache");
    const store = module.createNotesStore();
    const fence = await store.captureFence("fixture-account");
    await store.cacheAccepted(
      {
        accountId: "fixture-account",
        id: "fixture-link",
        document: JSON.stringify({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Link fixture" }],
            },
            {
              type: "paragraph",
              content: [
                { type: "text", text: "See " },
                {
                  type: "text",
                  text: "the site",
                  marks: [
                    { type: "link", attrs: { href: "https://example.net" } },
                  ],
                },
              ],
            },
          ],
        }),
        text: "Link fixture\nSee the site",
      },
      Date.now(),
      fence,
    );
    store.close();
  });
  await page.reload();
  await page.getByRole("button", { name: /Link fixture/ }).click();
  const viewer = page.getByRole("textbox", { name: "Note content" });
  await expect(viewer).toHaveClass(/ProseMirror/);
  await expect(viewer).toHaveAttribute("contenteditable", "false");
  await captureOpens(page);
  await viewer.locator("a").click();
  expect(await opened(page)).toEqual([
    ["https://example.net", "_blank", "noopener"],
  ]);
  await expect(page.getByRole("toolbar", { name: "Link" })).toHaveCount(0);
});

test("autolink on Enter; Backspace at a link's end unlinks it", async ({
  page,
}) => {
  const editor = await newNote(page);
  await editor.pressSequentially("Sites");
  await editor.press("Enter");
  await editor.pressSequentially("https://palladian.dev/a");
  await editor.press("Enter");
  await expect(editor.locator("a")).toHaveAttribute(
    "href",
    "https://palladian.dev/a",
  );
  await editor.pressSequentially("`code.com` ");
  await expect(editor.locator("code")).toHaveText("code.com");
  await expect(editor.locator("a")).toHaveCount(1);
  await editor.press("Home");
  await editor.press("ArrowLeft");
  await settle(page);
  await editor.press("Backspace");
  await expect(editor.locator("a")).toHaveCount(0);
  await expect(editor.locator("p").nth(1)).toHaveText(
    "https://palladian.dev/a",
  );
});

test("Markdown and HTML paste; copy writes Markdown", async ({ page }) => {
  const editor = await newNote(page);
  await markdownLoaded(page);
  await editor.click();
  await paste(editor, {
    "text/plain": "# Plan\n\n- one\n- two\n\n**bold** finish",
  });
  await expect(editor.locator("h1")).toHaveText("Plan");
  await expect(editor.locator("li")).toHaveText(["one", "two"]);
  await expect(editor.locator("strong")).toHaveText("bold");

  await editor.press("Enter");
  await paste(editor, {
    "text/plain": "Safe bold plain strong",
    "text/html":
      '<meta charset="utf-8"><style>p{color:red}</style><p>Safe <span style="font-weight:700" onclick="window.pwned=1">bold</span><img src="x" onerror="window.pwned=2"><script>window.pwned=3</script> <b style="font-weight:normal" id="docs-internal-guid-1"><span style="font-weight:400">plain</span> <span style="font-weight:700">strong</span></b></p>',
  });
  await expect(editor).toContainText("Safe bold plain strong");
  await expect(editor.locator("strong")).toHaveText(["bold", "bold", "strong"]);
  await page.waitForTimeout(200);
  expect(
    await page.evaluate(() => (window as unknown as { pwned?: number }).pwned),
  ).toBeUndefined();
  await expect(
    editor.locator("[style], [onclick], img, script, style"),
  ).toHaveCount(0);

  await editor.press("Enter");
  await paste(editor, { "text/plain": "just plain words" });
  await expect(editor.locator("p").last()).toHaveText("just plain words");

  const mod = await modKey(page);
  await editor.press(`${mod}+a`);
  const copied = await editor.evaluate((element) => {
    const transfer = new DataTransfer();
    element.dispatchEvent(
      new ClipboardEvent("copy", {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
    return transfer.getData("text/plain");
  });
  expect(copied).toBe(
    "# Plan\n\n- one\n- two\n\n**bold** finish\n\nSafe **bold** plain **strong**\n\njust plain words",
  );
});

test("Title placeholder, caret at the end, and tapping below the text", async ({
  page,
}, info) => {
  const editor = await newNote(page);
  const placeholder = editor.locator(".title-placeholder");
  await expect(placeholder).toHaveCount(1);
  expect(
    await placeholder.evaluate(
      (element) => getComputedStyle(element, "::before").content,
    ),
  ).toBe('"Title"');
  await expect(editor).toHaveText("");
  await editor.pressSequentially("Hello");
  await expect(placeholder).toHaveCount(0);
  await editor.press("Home");
  await editor.evaluate((element) => (element as HTMLElement).blur());
  const box = (await editor.boundingBox())!;
  await page.mouse.click(box.x + 40, box.y + box.height + 30);
  await expect(editor).toBeFocused();
  await page.keyboard.type("!");
  await expect(editor).toHaveText("Hello!");

  // Reopening a note with text puts the caret at its end.
  if (isMobile(info.project.name)) {
    await page.getByRole("button", { name: "All notes", exact: true }).click();
  } else {
    await page.getByRole("button", { name: /Welcome to your notes/ }).click();
  }
  await page.getByRole("button", { name: /Hello!/ }).click();
  await expect(editor).toHaveText("Hello!");
  await expect(editor).toHaveClass(/ProseMirror/);
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await editor.focus();
  await page.waitForTimeout(100);
  await page.keyboard.type("?");
  await expect(editor).toHaveText("Hello!?");
});

test("slash palette on wide screens only", async ({ page }, info) => {
  const editor = await newNote(page);
  await editor.pressSequentially("Title");
  await editor.press("Enter");
  await editor.pressSequentially("/");
  const palette = page.getByRole("listbox", { name: "Insert" });
  if (isMobile(info.project.name)) {
    await expect(palette).toHaveCount(0);
    await expect(editor.locator("p").nth(1)).toHaveText("/");
    return;
  }
  await expect(palette).toBeVisible();
  // Every entry but Body, which this line already is.
  await expect(palette.getByRole("option")).toHaveCount(10);
  await editor.pressSequentially("sub");
  await expect(palette.getByRole("option")).toHaveText(["Subhead"]);
  await editor.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(editor.locator("h3")).toHaveCount(1);
  await editor.pressSequentially("Section");
  await expect(editor.locator("h3")).toHaveText("Section");

  await editor.press("Enter");
  await editor.pressSequentially("/");
  await editor.press("ArrowDown");
  await expect(
    palette.getByRole("option", { name: "Heading", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await editor.press("Escape");
  await expect(palette).toHaveCount(0);
  await expect(editor.locator("p").last()).toHaveText("/");
  await editor.press("Backspace");
  await editor.pressSequentially("/");
  await palette.getByRole("option", { name: "Divider" }).click();
  await expect(editor.locator("hr")).toHaveCount(1);
  await expect(editor).toBeFocused();
  await editor.pressSequentially("/link");
  await editor.press("Enter");
  await expect(page.getByRole("textbox", { name: "Link text" })).toBeFocused();
});
