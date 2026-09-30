import { expect, test, type Page } from "@playwright/test";
async function seed(page: Page) {
  await page.goto("/?fixture=seed&session=stall");
  await expect(
    page.getByRole("button", { name: /Welcome to your notes/ }),
  ).toBeVisible();
}
async function appearance(page: Page, mobile: boolean) {
  if (mobile)
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Appearance", exact: true }),
  ).toBeVisible();
}
test("Deltos Graphite/Sans tokens and loaded font metrics match the reference", async ({
  page,
}, info) => {
  await seed(page);
  await page.getByRole("button", { name: /Welcome to your notes/ }).click();
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const metrics = await page.evaluate(() => {
    const css = (selector: string) => {
      const node = document.querySelector(selector);
      if (!node) throw new Error(selector);
      return getComputedStyle(node);
    };
    return {
      palette: document.documentElement.dataset.palette,
      paper: css(".note-surface").backgroundColor,
      nav: css(".navigation").backgroundColor,
      list: css(".library").backgroundColor,
      body: css(".ProseMirror").fontSize,
      family: css(".ProseMirror").fontFamily,
      title: css(".ProseMirror > p:first-child").fontSize,
      titleWeight: css(".ProseMirror > p:first-child").fontWeight,
      dateFamily: css(".editor-host > .edited-date").fontFamily,
      dateSize: css(".editor-host > .edited-date").fontSize,
      sansLoaded: document.fonts.check('16px "IBM Plex Sans"'),
      monoLoaded: document.fonts.check('11px "IBM Plex Mono"'),
      navWidth: document.querySelector(".navigation")!.getBoundingClientRect()
        .width,
      listWidth: document.querySelector(".library")!.getBoundingClientRect()
        .width,
    };
  });
  expect(metrics).toMatchObject({
    palette: "graphite",
    paper: "rgb(255, 255, 255)",
    nav: "rgb(240, 241, 243)",
    list: "rgb(247, 248, 250)",
    body: "16.5px",
    title: "33px",
    titleWeight: "700",
    dateSize: "11px",
    sansLoaded: true,
    monoLoaded: true,
  });
  expect(metrics.family).toContain("IBM Plex Sans");
  expect(metrics.dateFamily).toContain("IBM Plex Mono");
  if (!info.project.name.includes("mobile")) {
    expect(metrics.navWidth).toBe(222);
    expect(metrics.listWidth).toBe(300);
  }
});

test("appearance changes and settings round trip retain current draft and selection", async ({
  page,
}, info) => {
  await seed(page);
  await page
    .getByRole("button", { name: "New note", exact: true })
    .first()
    .click();
  const editor = page.getByRole("textbox", { name: "Note content" });
  await expect(editor).toHaveClass(/ProseMirror/);
  await editor.fill("Keep this draft through Appearance\nStill here");
  await expect(
    page.getByText("Draft saved on this device — not saved to server"),
  ).toBeVisible();
  const before = await page.evaluate(() => {
    const node = document.querySelector(".ProseMirror");
    (window as unknown as { savedEditor: Element | null }).savedEditor = node;
    return node?.textContent;
  });
  await appearance(page, info.project.name.includes("mobile"));
  await page.getByRole("radio", { name: "Ember", exact: true }).click();
  await page.getByRole("radio", { name: "Serif", exact: true }).click();
  await page.getByRole("radio", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "ember");
  await expect(page.locator("html")).toHaveAttribute("data-voice", "serif");
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await expect(editor).toContainText("Still here");
  expect(
    await page.evaluate(
      () =>
        document.querySelector(".ProseMirror") ===
        (window as unknown as { savedEditor: Element | null }).savedEditor,
    ),
  ).toBe(true);
  await editor.press("End");
  await editor.pressSequentially(" More words");
  await expect(editor).toContainText("More words");
  await expect(
    page.getByText("Draft saved on this device — not saved to server"),
  ).toBeVisible();
  expect(before).toContain("Keep this draft");
  await page.goto("/?fixture=1&session=stall");
  await expect(page.locator("html")).toHaveAttribute("data-palette", "ember");
  await expect(page.locator("html")).toHaveAttribute("data-voice", "serif");
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
  await page
    .getByRole("button", { name: /Keep this draft through Appearance/ })
    .click();
  await expect(editor).toContainText("More words");
});

test("all theme axes stay independent and system mode follows OS", async ({
  page,
}, info) => {
  await seed(page);
  await appearance(page, info.project.name.includes("mobile"));
  for (const palette of ["Bone", "Graphite", "Manila", "Ember"]) {
    await page.getByRole("radio", { name: palette, exact: true }).click();
    for (const voice of ["Serif", "Sans", "Mono", "Grotesk"]) {
      await page.getByRole("radio", { name: voice, exact: true }).click();
      for (const mode of ["Light", "Dark", "System"]) {
        await page.getByRole("radio", { name: mode, exact: true }).click();
        await expect(page.locator("html")).toHaveAttribute(
          "data-palette",
          palette.toLowerCase(),
        );
        await expect(page.locator("html")).toHaveAttribute(
          "data-voice",
          voice.toLowerCase(),
        );
        await expect(page.locator("html")).toHaveAttribute(
          "data-mode",
          mode.toLowerCase(),
        );
      }
    }
  }
  await page.getByRole("radio", { name: "Graphite", exact: true }).click();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator(".note-surface")).toHaveCSS(
    "background-color",
    "rgb(32, 34, 37)",
  );
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator(".note-surface")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
});

test("nested paragraphs keep body sizing instead of inheriting note title styling", async ({
  page,
}, info) => {
  await seed(page);
  await page
    .getByRole("button", { name: "New note", exact: true })
    .first()
    .click();
  const editor = page.getByRole("textbox", { name: "Note content" });
  await expect(editor).toHaveClass(/ProseMirror/);
  await editor.fill("A list entry");
  if (info.project.name.includes("mobile"))
    await page
      .getByRole("button", { name: "Lists tools", exact: true })
      .click();
  await page
    .getByRole("button", { name: "Bulleted list", exact: true })
    .click();
  await expect(page.locator(".ProseMirror li p")).toHaveCSS(
    "font-size",
    "16.5px",
  );
  await expect(page.locator(".ProseMirror li p")).toHaveCSS(
    "font-weight",
    "400",
  );
});
