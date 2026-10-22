import { expect, test, type Page } from "@playwright/test";

/**
 * Swipe-row gestures against the test-only harness (harness/swipe.html): two
 * rows whose actions and open state the test changes mid-gesture, with real
 * touch input through Chromium.
 */

/** What harness/swipe.html exposes to the tests. */
interface SwipeWindow {
  __swipe: {
    log: string[];
    open: string | null;
    setLayout(id: string, name: string): void;
    setOpen(id: string | null): void;
  };
}

test.skip(
  ({ isMobile }) => !isMobile,
  "touch gestures run in the phone project",
);

async function harness(page: Page) {
  await page.goto("/harness/swipe.html");
  await expect(page.getByRole("button", { name: "Row A" })).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  const touch = (
    type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
    x = 0,
    y = 0,
  ) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints:
        type === "touchEnd" || type === "touchCancel" ? [] : [{ x, y }],
    });
  const center = async (id: string) => {
    const box = (await page
      .getByRole("button", { name: `Row ${id}` })
      .boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  return {
    touch,
    center,
    /** How far the row's front is moved, in pixels. */
    offset: (id: string) =>
      page
        .locator(`[data-row="${id}"] .swipe-front`)
        .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41),
    /** Swipe left and rest open on Move and Share. */
    async openLeft(id: string) {
      const at = await center(id);
      await touch("touchStart", at.x, at.y);
      for (let i = 1; i <= 10; i++) {
        await touch("touchMove", at.x - 12 * i, at.y);
        await page.waitForTimeout(16);
      }
      await page.waitForTimeout(150);
      await touch("touchEnd");
      await expect.poll(() => this.offset(id)).toBe(-152);
    },
    state: () =>
      page.evaluate(() => {
        const swipe = (window as unknown as SwipeWindow).__swipe;
        return { open: swipe.open, log: [...swipe.log] };
      }),
    set: (id: string, name: "full" | "trashed" | "none") =>
      page.evaluate(
        ([id, name]) =>
          (window as unknown as SwipeWindow).__swipe.setLayout(id, name),
        [id, name] as const,
      ),
    setOpen: (id: string | null) =>
      page.evaluate(
        (id) => (window as unknown as SwipeWindow).__swipe.setOpen(id),
        id,
      ),
  };
}

test("actions that change while a finger rests: every exit follows them", async ({
  page,
}) => {
  const rows = await harness(page);
  await rows.openLeft("A");
  let at = await rows.center("A");

  // Fewer actions, then the touch is cancelled before it moved.
  await rows.touch("touchStart", at.x, at.y);
  await rows.set("A", "trashed");
  await rows.touch("touchCancel");
  await expect.poll(() => rows.offset("A")).toBe(-76);
  expect((await rows.state()).open).toBe("A");

  // Fewer actions, then a scroll takes over.
  await rows.set("A", "full");
  await rows.setOpen(null);
  await expect.poll(() => rows.offset("A")).toBe(0);
  await rows.openLeft("A");
  at = await rows.center("A");
  await rows.touch("touchStart", at.x, at.y);
  await rows.set("A", "trashed");
  await rows.touch("touchMove", at.x, at.y + 30);
  await rows.touch("touchEnd");
  await expect.poll(() => rows.offset("A")).toBe(-76);

  // No actions left, then the finger lifts without moving: the row closes
  // and the tap does not open the note.
  await rows.touch("touchStart", at.x, at.y);
  await rows.set("A", "none");
  await rows.touch("touchEnd", at.x, at.y);
  await expect.poll(() => rows.offset("A")).toBe(0);
  const state = await rows.state();
  expect(state.open).toBeNull();
  expect(state.log).not.toContain("A:select");
});

test("a row the list closed during a gesture stays closed", async ({
  page,
}) => {
  const rows = await harness(page);
  // Cancelled before it moved.
  await rows.openLeft("A");
  let at = await rows.center("A");
  await rows.touch("touchStart", at.x, at.y);
  await rows.setOpen("B");
  await rows.touch("touchCancel");
  await expect.poll(() => rows.offset("A")).toBe(0);
  expect((await rows.state()).open).toBe("B");

  // Lifted without moving: closed, the open row is left alone, no selection.
  await rows.setOpen(null);
  await rows.openLeft("A");
  at = await rows.center("A");
  await rows.touch("touchStart", at.x, at.y);
  await rows.setOpen("B");
  await rows.touch("touchEnd", at.x, at.y);
  await expect.poll(() => rows.offset("A")).toBe(0);
  const state = await rows.state();
  expect(state.open).toBe("B");
  expect(state.log).not.toContain("A:select");

  // Cancelled after a horizontal drag began.
  await rows.setOpen(null);
  await rows.openLeft("A");
  at = await rows.center("A");
  await rows.touch("touchStart", at.x, at.y);
  for (let i = 1; i <= 4; i++)
    await rows.touch("touchMove", at.x - 6 * i, at.y);
  await rows.setOpen("B");
  await rows.touch("touchCancel");
  await expect.poll(() => rows.offset("A")).toBe(0);
  expect((await rows.state()).open).toBe("B");
});

test("a tap on an open row only closes it; the keyboard still opens the note", async ({
  page,
}) => {
  const rows = await harness(page);
  await rows.openLeft("A");
  const at = await rows.center("A");
  await rows.touch("touchStart", at.x, at.y);
  await rows.touch("touchEnd", at.x, at.y);
  await expect.poll(() => rows.offset("A")).toBe(0);
  expect((await rows.state()).log).not.toContain("A:select");
  await page.getByRole("button", { name: "Row A" }).focus();
  await page.keyboard.press("Enter");
  expect((await rows.state()).log).toContain("A:select");
});
