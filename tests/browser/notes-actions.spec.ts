import { expect, test, type Page } from "@playwright/test";

async function seed(page: Page) {
  await page.goto("/?fixture=seed&session=stall");
  await expect(
    page.getByRole("button", { name: /Welcome to your notes/ }),
  ).toBeVisible();
}

/** Real touch input through Chromium, so pointer and touch events fire. */
async function touch(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (
    type: "touchStart" | "touchMove" | "touchEnd",
    x: number,
    y: number,
  ) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x, y }],
    });
  return {
    async longPress(x: number, y: number) {
      await send("touchStart", x, y);
      await page.waitForTimeout(650);
      await send("touchEnd", x, y);
    },
    async drag(x: number, y: number, dx: number, dy: number) {
      await send("touchStart", x, y);
      for (let step = 1; step <= 10; step++) {
        await send("touchMove", x + (dx * step) / 10, y + (dy * step) / 10);
        await page.waitForTimeout(16);
      }
      await send("touchEnd", x + dx, y + dy);
    },
    async swipe(x: number, y: number, dx: number) {
      await send("touchStart", x, y);
      for (let step = 1; step <= 10; step++) {
        await send("touchMove", x + (dx * step) / 10, y);
        await page.waitForTimeout(16);
      }
      await send("touchEnd", x + dx, y);
    },
  };
}

async function rowCenter(page: Page, name: RegExp) {
  const box = (await page.getByRole("button", { name }).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test("wide screens: right-click, the row's … and the menu key open the note's actions", async ({
  page,
}, info) => {
  test.skip(info.project.name.includes("mobile"), "wide layout");
  await seed(page);
  const row = page.getByRole("button", { name: /^Welcome to your notes/ });
  await row.click({ button: "right" });
  const menu = page.getByRole("dialog", {
    name: "Actions for Welcome to your notes",
  });
  // Offline, only what works without the server is offered.
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Export as Markdown",
    "Print or save as PDF",
  ]);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await row.hover();
  await page
    .locator(".note-row-wrap", { has: row })
    .locator(".row-more")
    .click();
  await expect(menu).toBeVisible();
  const download = page.waitForEvent("download");
  await menu.getByRole("menuitem", { name: "Export as Markdown" }).click();
  const file = await download;
  // Keyboards reach the same menu from the focused row.
  await row.focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  expect(file.suggestedFilename()).toBe("Welcome to your notes.md");
  const text = await (await file.createReadStream()).toArray();
  expect(Buffer.concat(text).toString("utf8")).toContain(
    "This text comes from IndexedDB",
  );
});

test("phones: a long press opens the action sheet; swipes need the server", async ({
  page,
}, info) => {
  test.skip(!info.project.name.includes("mobile"), "touch layout");
  await seed(page);
  const fingers = await touch(page);
  const point = await rowCenter(page, /Welcome to your notes/);
  await fingers.longPress(point.x, point.y);
  const sheet = page.getByRole("dialog", {
    name: "Actions for Welcome to your notes",
  });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("menuitem")).toHaveText([
    "Export as Markdown",
    "Print or save as PDF",
  ]);
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(sheet).toBeHidden();
  // The long press did not open the note.
  await expect(
    page.getByRole("textbox", { name: "Note content" }),
  ).toBeHidden();
  // Offline every swipe action needs the server, so the row does not move.
  await fingers.swipe(point.x, point.y, -220);
  await expect(page.locator(".swipe-actions")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Welcome to your notes/ }),
  ).toBeVisible();
});

test("phones: releasing the long press over the new sheet does not pick an action", async ({
  page,
}, info) => {
  test.skip(!info.project.name.includes("mobile"), "touch layout");
  // A short screen: the sheet opens under the finger.
  await page.setViewportSize({ width: 430, height: 380 });
  await seed(page);
  const fingers = await touch(page);
  const point = await rowCenter(page, /A longer note/);
  const sheet = page.getByRole("dialog", { name: "Actions for A longer note" });
  let downloads = 0;
  page.on("download", () => downloads++);
  await fingers.longPress(point.x, point.y);
  const under = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest("dialog") !== null,
    point,
  );
  expect(under).toBe(true);
  await page.waitForTimeout(300);
  await expect(sheet).toBeVisible();
  expect(downloads).toBe(0);
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(sheet).toBeHidden();
});

test("the open note's … menu offers its actions", async ({ page }, info) => {
  await seed(page);
  await page.getByRole("button", { name: /Welcome to your notes/ }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  const menu = page.getByRole("dialog", {
    name: "Actions for Welcome to your notes",
  });
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Export as Markdown",
    "Print or save as PDF",
  ]);
  if (info.project.name.includes("mobile"))
    await menu.getByRole("button", { name: "Cancel" }).click();
  else await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(
    page.getByRole("textbox", { name: "Note content" }),
  ).toBeVisible();
});

test("phones: swipe up from the bottom bar opens the navigation, swipe down closes it", async ({
  page,
}, info) => {
  test.skip(!info.project.name.includes("mobile"), "touch layout");
  await seed(page);
  const fingers = await touch(page);
  const bar = (await page.locator(".mobile-home-bar").boundingBox())!;
  await fingers.drag(bar.x + bar.width / 2, bar.y + 10, 0, -120);
  const sheet = page.getByRole("dialog", { name: "Navigation" });
  await expect(sheet).toBeVisible();
  const box = (await sheet.boundingBox())!;
  await fingers.drag(box.x + box.width / 2, box.y + 30, 0, 160);
  await expect(sheet).toBeHidden();
});
