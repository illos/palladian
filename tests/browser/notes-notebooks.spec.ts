import { expect, test, type Page } from "@playwright/test";

/**
 * Notebook menus and counts (plan 08, A5) in fixture mode. The session
 * stalls, so the app is offline: menus may offer only what works without the
 * server. The real-service flows are in apps/notes/scripts/notebooks-e2e.mjs.
 */

async function seed(page: Page) {
  await page.goto("/?fixture=seed&session=stall");
  await expect(
    page.getByRole("button", { name: /Welcome to your notes/ }),
  ).toBeVisible();
  // Three notebooks as the library feed would cache them: Journal holds the
  // welcome note and, in Trash, the long one; Notes holds one more.
  await page.evaluate(async () => {
    type Store = {
      captureFence(accountId: string): Promise<unknown>;
      setNotebooks(
        accountId: string,
        notebooks: unknown[],
        fence: unknown,
      ): Promise<void>;
      cacheSummaries(
        accountId: string,
        rows: unknown[],
        removed: string[],
        fence: unknown,
      ): Promise<string[]>;
    };
    const store = (window as unknown as { __notesHarness: { store: Store } })
      .__notesHarness.store;
    const account = "fixture-account";
    const fence = await store.captureFence(account);
    const book = (
      id: string,
      name: string,
      role: string,
      isDefault = false,
    ) => ({ id, name, description: "", role, ownerName: "Ada", isDefault });
    await store.setNotebooks(
      account,
      [
        book("book-journal", "Journal", "owner"),
        book("book-notes", "Notes", "owner", true),
        book("book-team", "Team", "edit"),
        book("book-recipes", "Recipes", "read"),
      ],
      fence,
    );
    const summary = (
      id: string,
      title: string,
      notebookId: string,
      trashed = false,
    ) => ({
      id,
      title,
      preview: "",
      updatedAt: 1_700_000_000_000,
      notebookId,
      role: "owner",
      trashed,
    });
    await store.cacheSummaries(
      account,
      [
        summary("fixture-welcome", "Welcome to your notes", "book-journal"),
        summary("fixture-long", "A longer note", "book-journal", true),
        summary("fixture-third", "Third note", "book-notes"),
      ],
      [],
      fence,
    );
  });
  await expect(page.getByRole("button", { name: /Third note/ })).toBeVisible();
}

/** The navigation: the sidebar on wide screens, the sheet on phones. */
async function navigation(page: Page, phone: boolean) {
  if (!phone) return page.locator("aside.navigation");
  await page.getByRole("button", { name: "Menu" }).click();
  const sheet = page.getByRole("dialog", { name: "Navigation" });
  await expect(sheet).toBeVisible();
  return sheet;
}

/** Real touch input through Chromium, so pointer and touch events fire. */
async function longPress(page: Page, x: number, y: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  await page.waitForTimeout(650);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
}

const menuFor = (page: Page, name: string) =>
  page.getByRole("dialog", { name: `Actions for notebook ${name}` });

test("notebooks show how many notes this device has in them, Trash left out", async ({
  page,
}, info) => {
  await seed(page);
  const nav = await navigation(page, info.project.name.includes("mobile"));
  const count = (name: string) =>
    nav.locator(".nav-row", { hasText: name }).locator(".nav-count");
  await expect(count("Journal")).toHaveText("1");
  await expect(count("Notes")).toHaveText("1");
  await expect(count("Recipes")).toHaveText("0");
  // The count is a visual aid; the notebook keeps its plain name.
  await expect(
    nav.getByRole("button", { name: "Journal", exact: true }),
  ).toBeVisible();
  await expect(
    nav.getByRole("button", { name: "Recipes Shared", exact: true }),
  ).toBeVisible();
});

test("wide screens: right-click, the hover … and the menu key open a notebook's menu", async ({
  page,
}, info) => {
  test.skip(info.project.name.includes("mobile"), "wide layout");
  await seed(page);
  const nav = page.locator("aside.navigation");
  const journal = nav.getByRole("button", { name: "Journal", exact: true });
  await journal.click({ button: "right" });
  const menu = menuFor(page, "Journal");
  // Offline only a new note (kept as a draft on this device) is offered.
  await expect(menu.getByRole("menuitem")).toHaveText(["New note here"]);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  // Right-click did not open the notebook.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("All notes");

  const row = (name: string) =>
    nav.locator(".nav-row").filter({
      has: page.getByRole("button", { name, exact: true }),
    });
  await journal.hover();
  await row("Journal").locator(".nav-more").click();
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  await journal.focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "New note here" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Journal");
  await expect(
    page.getByRole("textbox", { name: "Note content" }),
  ).toBeVisible();
  // The new note waits in Journal as a draft on this device.
  await expect(row("Journal").locator(".nav-count")).toHaveText("2");

  // The list header's … opens the same menu.
  await page.getByRole("button", { name: "Notebook actions" }).click();
  await expect(menu.getByRole("menuitem")).toHaveText(["New note here"]);
  await page.keyboard.press("Escape");

  // A read-only notebook offers nothing offline: no menu and no "…".
  const recipes = nav.getByRole("button", { name: /^Recipes/ });
  await recipes.click({ button: "right" });
  await expect(menuFor(page, "Recipes")).toBeHidden();
  await expect(row("Recipes Shared").locator(".nav-more")).toHaveCount(0);
  await recipes.click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Recipes");
  await expect(
    page.getByRole("button", { name: "Notebook actions" }),
  ).toHaveCount(0);
});

test("phones: a long press on a notebook in the navigation opens its sheet", async ({
  page,
}, info) => {
  test.skip(!info.project.name.includes("mobile"), "touch layout");
  await seed(page);
  const sheet = await navigation(page, true);
  const team = sheet.getByRole("button", { name: /^Team/ });
  const box = (await team.boundingBox())!;
  await longPress(page, box.x + box.width / 2, box.y + box.height / 2);
  const menu = menuFor(page, "Team");
  await expect(menu).toBeVisible();
  // An editor's notebook, offline: a new note only.
  await expect(menu.getByRole("menuitem")).toHaveText(["New note here"]);
  await menu.getByRole("button", { name: "Cancel" }).click();
  await expect(menu).toBeHidden();
  // The long press did not open the notebook.
  await expect(sheet).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("All notes");

  // A read-only notebook offers nothing offline.
  const recipes = sheet.getByRole("button", { name: /^Recipes/ });
  const at = (await recipes.boundingBox())!;
  await longPress(page, at.x + at.width / 2, at.y + at.height / 2);
  await page.waitForTimeout(200);
  await expect(menuFor(page, "Recipes")).toBeHidden();
  // Nor did that long press open it.
  await expect(sheet).toBeVisible();

  // The notebook's list header has the same menu.
  await sheet.getByRole("button", { name: "Journal", exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Journal");
  await page.getByRole("button", { name: "Notebook actions" }).click();
  const journal = menuFor(page, "Journal");
  await expect(journal.getByRole("menuitem")).toHaveText(["New note here"]);
  await journal.getByRole("menuitem", { name: "New note here" }).click();
  await expect(
    page.getByRole("textbox", { name: "Note content" }),
  ).toBeVisible();
});

/** Replace the cached notebooks, as an access snapshot would. */
async function listNotebooks(page: Page, ids: string[]) {
  await page.evaluate(async (keep) => {
    type Store = {
      captureFence(accountId: string): Promise<unknown>;
      setNotebooks(
        accountId: string,
        notebooks: unknown[],
        fence: unknown,
      ): Promise<void>;
    };
    const store = (window as unknown as { __notesHarness: { store: Store } })
      .__notesHarness.store;
    const all = [
      ["book-journal", "Journal", "owner", false],
      ["book-notes", "Notes", "owner", true],
      ["book-team", "Team", "edit", false],
      ["book-recipes", "Recipes", "read", false],
    ] as const;
    await store.setNotebooks(
      "fixture-account",
      all
        .filter(([id]) => keep.includes(id))
        .map(([id, name, role, isDefault]) => ({
          id,
          name,
          description: "",
          role,
          ownerName: "Ada",
          isDefault,
        })),
      await store.captureFence("fixture-account"),
    );
  }, ids);
}

test("review round 1, F1: a notebook removed elsewhere stops being shown", async ({
  page,
}, info) => {
  await seed(page);
  const phone = info.project.name.includes("mobile");
  const nav = await navigation(page, phone);
  await nav.getByRole("button", { name: "Journal", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Journal");
  // Another device deleted Journal: the next access snapshot leaves it out.
  await listNotebooks(page, ["book-notes", "book-team", "book-recipes"]);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("All notes");
  await expect(
    page.getByRole("button", { name: "Notebook actions" }),
  ).toHaveCount(0);
});

test("review round 1, F1: a new note never goes to a notebook that does not take it", async ({
  page,
}, info) => {
  await seed(page);
  const phone = info.project.name.includes("mobile");
  const nav = await navigation(page, phone);
  await nav.getByRole("button", { name: /^Recipes/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Recipes");
  // The read-only notebook's list stays open; the new note is a draft for
  // the default notebook, not for Recipes.
  if (phone)
    await page
      .locator(".mobile-home-actions")
      .getByRole("button", { name: "New note" })
      .click();
  else
    await page
      .locator(".welcome")
      .getByRole("button", { name: "New note" })
      .click();
  await expect(
    page.getByText("Draft saved on this device — not saved to server"),
  ).toBeVisible();
  if (!phone)
    await expect(
      nav.locator(".nav-row", { hasText: "Recipes" }).locator(".nav-count"),
    ).toHaveText("0");
  const drafts = await page.evaluate(async () => {
    type Store = {
      list(accountId: string): Promise<{ kind: string; notebookId?: string }[]>;
    };
    const store = (window as unknown as { __notesHarness: { store: Store } })
      .__notesHarness.store;
    return (await store.list("fixture-account"))
      .filter((row) => row.kind === "draft")
      .map((row) => row.notebookId ?? null);
  });
  expect(drafts).toEqual([null]);
});

/** The notebook each local draft is for, as this device stores it. */
async function draftNotebooks(page: Page) {
  return page.evaluate(async () => {
    type Store = {
      list(
        accountId: string,
      ): Promise<{ id: string; title: string; notebookId?: string }[]>;
    };
    const store = (window as unknown as { __notesHarness: { store: Store } })
      .__notesHarness.store;
    return Object.fromEntries(
      (await store.list("fixture-account"))
        .filter((row) => row.id.startsWith("local-"))
        .map((row) => [row.title, row.notebookId ?? null]),
    );
  });
}

/** Start a note in the notebook shown and type a first line. */
async function typeNewNote(page: Page, phone: boolean, text: string) {
  const bar = phone
    ? page.locator(".mobile-home-actions")
    : page.locator(".library-header");
  await bar.getByRole("button", { name: "New note" }).click();
  const editor = page.getByRole("textbox", { name: "Note content" });
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type(text);
  await expect(
    page.getByText("Draft saved on this device — not saved to server"),
  ).toBeVisible();
  // Leave the note so the list shows (phones show one or the other).
  if (phone) await page.getByRole("button", { name: "All notes" }).click();
}

test("review round 2, R2-1: a draft for a notebook that stops taking the person's notes is not shown", async ({
  page,
}, info) => {
  await seed(page);
  const phone = info.project.name.includes("mobile");
  // A collaborator's draft in Team, and the owner's draft in Journal.
  let nav = await navigation(page, phone);
  await nav.getByRole("button", { name: /^Team/ }).click();
  await typeNewNote(page, phone, "Team draft");
  nav = await navigation(page, phone);
  await nav.getByRole("button", { name: "Journal", exact: true }).click();
  await typeNewNote(page, phone, "Journal draft");
  expect(await draftNotebooks(page)).toEqual({
    "Team draft": "book-team",
    "Journal draft": "book-journal",
  });
  if (!phone) {
    // The owner's draft is open; open the collaborator's one from All Notes.
    await nav.getByRole("button", { name: /^All Notes/ }).click();
    await page.getByRole("button", { name: /^Team draft/ }).click();
    await expect(
      page.getByRole("textbox", { name: "Note content" }),
    ).toContainText("Team draft");
  }

  // Team's owner deletes it, and Journal goes too (its owner is this person).
  await listNotebooks(page, ["book-notes", "book-recipes"]);
  const editor = page.getByRole("textbox", { name: "Note content" });
  await expect(editor).toBeHidden();
  if (!phone)
    await expect(page.getByRole("alert")).toContainText(
      "no longer takes your notes",
    );
  const teamRow = page.getByRole("button", { name: /^Team draft/ });
  await expect(teamRow.locator(".row-unavailable")).toHaveText("Not available");
  // Its text is not shown in the list either.
  await expect(teamRow.locator(".row-preview")).toHaveText(
    "Its notebook no longer takes your notes",
  );
  await teamRow.click();
  await expect(editor).toBeHidden();
  // The person's own draft stays available: the server files it in their
  // default notebook.
  const journalRow = page.getByRole("button", { name: /^Journal draft/ });
  await expect(journalRow.locator(".row-unavailable")).toHaveCount(0);
  await journalRow.click();
  await expect(editor).toContainText("Journal draft");
  // Neither draft was sent somewhere else.
  expect(await draftNotebooks(page)).toEqual({
    "Team draft": "book-team",
    "Journal draft": "book-journal",
  });
});
