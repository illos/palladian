import { expect, test } from "@playwright/test";
import type { RecordStore } from "../../apps/notes/src/restore-store";

// History reads the server's revisions, so it is offered only while the
// server is reachable, and only to editors (plan 08, A4; D13). Fixture mode
// has no server, so these are the offline cases: connecting, unreachable, and
// signed in before the live connection is ready. Readers and the panel itself
// are covered against real services by apps/notes/scripts/history-e2e.mjs.
for (const session of ["stall", "transient", "ready"]) {
  test(`History is not offered without the server (session ${session})`, async ({
    page,
  }) => {
    await page.goto("/?fixture=seed&session=" + session);
    const row = page.getByRole("button", { name: /^Welcome to your notes/ });
    await expect(row).toBeVisible();
    const menu = page.getByRole("dialog", {
      name: "Actions for Welcome to your notes",
    });

    // The row's menu (the sheet on phones), opened from the keyboard.
    await row.focus();
    await page.keyboard.press("Shift+F10");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Export as Markdown",
      "Print or save as PDF",
    ]);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    // The open note: no toolbar button, nothing under "…".
    await row.click();
    await expect(
      page.getByRole("textbox", { name: "Note content" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Note history" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "More actions" }).click();
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "History" })).toHaveCount(
      0,
    );
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(page.getByRole("dialog", { name: /^History of/ })).toHaveCount(
      0,
    );
  });
}

// Review round 4 (R4-2): two pages of one browser change the restore records
// at the same time, through the app's own store and the browser's IndexedDB.
// Overlapping inserts, and an insert against another page's completion
// (removing one record, marking another applied), must all persist.
test("restore records: two pages' overlapping changes all persist", async ({
  context,
  page,
}) => {
  await page.goto("/?fixture=1&session=stall");
  const other = await context.newPage();
  await other.goto("/?fixture=1&session=stall");
  const record = (requestId: string) => ({
    accountId: "account-a",
    noteId: "note-" + requestId,
    revision: 1,
    expectedRevision: 2,
    requestId,
    versionEndedAt: 1,
    since: 1,
  });
  type Change =
    | { add: ReturnType<typeof record> }
    | { remove: string }
    | { applied: string };
  /** Runs changes in a page, all at once, through the app's store. */
  const run = (target: typeof page, changes: Change[]) =>
    target.evaluate(async (changes) => {
      const path = "/src/restore-store.ts";
      const module: {
        openRecordStore: () => RecordStore | null;
      } = await import(path);
      const store = module.openRecordStore()!;
      await Promise.all(
        changes.map((change) =>
          "add" in change
            ? store.add(change.add, 100)
            : "remove" in change
              ? store.remove([change.remove])
              : store.markApplied(change.applied, 9, 1),
        ),
      );
      return (await store.list()).records
        .map((r) => `${r.requestId}:${r.appliedRevision ?? "-"}`)
        .sort();
    }, changes);
  await run(page, [{ add: record("seed-1") }, { add: record("seed-2") }]);
  const [here, there] = await Promise.all([
    run(
      page,
      Array.from({ length: 10 }, (_, i) => ({ add: record(`a${i}`) })),
    ),
    run(other, [
      { remove: "seed-1" },
      { applied: "seed-2" },
      ...Array.from({ length: 10 }, (_, i) => ({ add: record(`b${i}`) })),
    ]),
  ]);
  const expected = [
    ...Array.from({ length: 10 }, (_, i) => `a${i}:-`),
    ...Array.from({ length: 10 }, (_, i) => `b${i}:-`),
    "seed-2:9",
  ].sort();
  const final = await run(page, []);
  expect(final).toEqual(expected);
  // Each page's own last read included its own changes.
  expect(here).toEqual(
    expect.arrayContaining(expected.filter((r) => r.startsWith("a"))),
  );
  expect(there).toEqual(
    expect.arrayContaining(expected.filter((r) => r.startsWith("b"))),
  );
});
