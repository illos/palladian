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

// After the list opens another row mid-gesture, a deliberate drag of this
// row still decides its state; everything else leaves the other row open.
// (Kept from the round-5 review's probes.)
const afterExternalOpen: {
  name: string;
  startClosed?: boolean;
  run: (
    rows: Awaited<ReturnType<typeof harness>>,
    at: { x: number; y: number },
    page: Page,
  ) => Promise<void>;
  offset: number;
  open: string;
  log?: string[];
}[] = [
  {
    name: "a quick flick that opens reclaims the row",
    async run(rows, at, page) {
      await rows.touch("touchMove", at.x + 130, at.y);
      await page.waitForTimeout(140);
      await rows.setOpen("B");
      await expect.poll(async () => (await rows.state()).open).toBe("B");
      await rows.touch("touchMove", at.x + 120, at.y);
      await rows.touch("touchMove", at.x + 100, at.y);
      await rows.touch("touchEnd");
    },
    offset: -152,
    open: "A",
  },
  {
    name: "a quick flick that closes leaves the other row open",
    async run(rows, at) {
      await rows.setOpen("B");
      await rows.touch("touchMove", at.x + 35, at.y);
      await rows.touch("touchMove", at.x + 55, at.y);
      await rows.touch("touchEnd");
    },
    offset: 0,
    open: "B",
  },
  {
    name: "a full swipe still moves the note to Trash",
    async run(rows, at) {
      await rows.touch("touchMove", at.x - 80, at.y);
      await rows.setOpen("B");
      await rows.touch("touchEnd");
    },
    offset: 0,
    open: "B",
    log: ["A:trash"],
  },
  {
    name: "a full swipe after its actions vanished does nothing",
    async run(rows, at) {
      await rows.touch("touchMove", at.x - 80, at.y);
      await rows.setOpen("B");
      await rows.set("A", "none");
      await rows.touch("touchEnd");
    },
    offset: 0,
    open: "B",
    log: [],
  },
  {
    name: "a slow drag that rests open reclaims the row",
    async run(rows, at, page) {
      await rows.touch("touchMove", at.x - 20, at.y);
      await rows.setOpen("B");
      await page.waitForTimeout(140);
      await rows.touch("touchEnd");
    },
    offset: -152,
    open: "A",
  },
  {
    name: "a drag cancelled on a closed row leaves the other row open",
    startClosed: true,
    async run(rows, at) {
      await rows.touch("touchMove", at.x - 40, at.y);
      await rows.setOpen("B");
      await rows.touch("touchCancel");
    },
    offset: 0,
    open: "B",
  },
];

for (const gesture of afterExternalOpen)
  test(`another row opened mid-gesture: ${gesture.name}`, async ({ page }) => {
    const rows = await harness(page);
    if (!gesture.startClosed) await rows.openLeft("A");
    const box = (await page
      .getByRole("button", { name: "Row A" })
      .boundingBox())!;
    const at = {
      x: Math.min(180, box.x + box.width - 20),
      y: box.y + box.height / 2,
    };
    await rows.touch("touchStart", at.x, at.y);
    await gesture.run(rows, at, page);
    await expect.poll(() => rows.offset("A")).toBe(gesture.offset);
    const state = await rows.state();
    expect(state.open).toBe(gesture.open);
    if (gesture.log) expect(state.log).toEqual(gesture.log);
    expect(state.log).not.toContain("A:select");
  });

test("an open row's revealed actions and the keyboard still work", async ({
  page,
}) => {
  const rows = await harness(page);
  await rows.openLeft("A");
  await page.getByRole("button", { name: "Share", exact: true }).tap();
  expect((await rows.state()).log).toEqual(["A:share"]);
  await expect.poll(() => rows.offset("A")).toBe(0);
  await rows.openLeft("A");
  await page.getByRole("button", { name: "Row A" }).focus();
  await page.keyboard.press("Enter");
  expect((await rows.state()).log).toEqual(["A:share", "A:select"]);
  await expect.poll(() => rows.offset("A")).toBe(0);
});
