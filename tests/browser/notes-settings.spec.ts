import { expect, test, type Page } from "@playwright/test";

async function seed(page: Page) {
  await page.goto("/?fixture=seed&session=stall");
  await expect(
    page.getByRole("button", { name: /Welcome to your notes/ }),
  ).toBeVisible();
}

const tabs = [
  "Account",
  "Security & devices",
  "Connected agents",
  "Appearance",
  "About",
];

test("phones open a Settings list and reach every tab and back", async ({
  page,
}, info) => {
  test.skip(!info.project.name.includes("mobile"), "phone layout");
  await seed(page);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  for (const tab of tabs) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await expect(
      page.getByRole("heading", { name: tab, exact: true }),
    ).toBeVisible();
    // The in-app back button returns to the list…
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible();
  }
  // …and so does the browser's Back.
  await page.getByRole("button", { name: "About", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/about$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Welcome to your notes/ }),
  ).toBeVisible();
  await expect(page).not.toHaveURL(/settings/);
});

test("wide screens open Account and switch tabs in the rail", async ({
  page,
}, info) => {
  test.skip(info.project.name.includes("mobile"), "wide layout");
  await seed(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/account$/);
  await expect(
    page.getByRole("heading", { name: "Account", exact: true }),
  ).toBeVisible();
  for (const tab of tabs) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await expect(
      page.getByRole("heading", { name: tab, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: tab, exact: true }),
    ).toHaveAttribute("aria-current", "page");
  }
  // Switching tabs replaces the entry, so one Back returns to the notes.
  await page.goBack();
  await expect(page).not.toHaveURL(/settings/);
  await expect(
    page.getByRole("button", { name: /Welcome to your notes/ }),
  ).toBeVisible();
});

test("the status under the notes opens Account, with Retry and Sign out offline", async ({
  page,
}, info) => {
  await seed(page);
  await expect(page.locator(".connection-footer details")).toHaveCount(0);
  await page.locator(".connection-status").click();
  await expect(
    page.getByRole("heading", { name: "Account", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("settings-session-status")).toHaveText(
    /Connecting/,
  );
  await expect(
    page.getByRole("button", { name: "Retry connection" }),
  ).toBeEnabled();
  // Sign out asks first; Cancel leaves the account signed in.
  await page.getByRole("button", { name: "Sign out…" }).click();
  await expect(
    page.getByRole("button", { name: "Sign out of this device" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Sign out of this device" }),
  ).toHaveCount(0);
  if (info.project.name.includes("mobile"))
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Welcome to your notes/ }),
  ).toBeVisible();
});

test("a Settings link opens its tab directly, and About shows the build", async ({
  page,
}) => {
  await seed(page);
  await page.goto("/settings/about?fixture=1&session=stall");
  await expect(
    page.getByRole("heading", { name: "About", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".about-facts dd").first()).not.toBeEmpty();
  await expect(
    page.getByText(/starts once every Palladian window is closed/),
  ).toBeVisible();
  // Leaving a directly opened tab lands on the notes, not outside the app.
  await page
    .getByRole("button", { name: "Settings", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Welcome to your notes/ }),
  ).toBeVisible();
  await expect(page).not.toHaveURL(/settings/);
});

/** Settings from the open note: phones use the navigation sheet. */
async function settingsFromNote(page: Page, mobile: boolean) {
  if (mobile)
    await page.getByRole("button", { name: "Open navigation" }).first().click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
}

test("reloading in Settings, then going back, reopens the note in the address", async ({
  page,
}, info) => {
  const mobile = info.project.name.includes("mobile");
  await seed(page);
  await page.getByRole("button", { name: /Welcome to your notes/ }).click();
  await expect(page).toHaveURL(/\/notes\/[A-Za-z0-9_-]+$/);
  const noteUrl = page.url();
  const editor = page.getByRole("textbox", { name: "Note content" });
  await expect(editor).toContainText(
    "Opening it does not need a session token",
  );
  await settingsFromNote(page, mobile);
  await expect(page).toHaveURL(/\/settings/);
  await page.reload();
  await expect(page).toHaveURL(/\/settings/);
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await expect(page).toHaveURL(noteUrl);
  await expect(editor).toContainText(
    "Opening it does not need a session token",
  );
});

test("a note that finishes opening while Settings shows does not replace the Settings address", async ({
  page,
}, info) => {
  test.skip(
    info.project.name.includes("mobile"),
    "wide layout keeps Settings one tap away",
  );
  await seed(page);
  // Hold the cached-note read so the open completes after Settings opens.
  await page.evaluate(() => {
    const harness = (
      window as unknown as {
        __notesHarness: {
          store: { read: (...args: unknown[]) => Promise<unknown> };
        };
      }
    ).__notesHarness;
    const read = harness.store.read.bind(harness.store);
    harness.store.read = (...args) =>
      new Promise((resolve) => setTimeout(() => resolve(read(...args)), 800));
  });
  await page.getByRole("button", { name: /Welcome to your notes/ }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/account$/);
  await page.waitForTimeout(1200);
  await expect(page).toHaveURL(/\/settings\/account$/);
  await expect(
    page.getByRole("heading", { name: "Account", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await expect(page).toHaveURL(/\/notes\/[A-Za-z0-9_-]+$/);
  await expect(
    page.getByRole("textbox", { name: "Note content" }),
  ).toContainText("Opening it does not need a session token");
});

test("a note still opening from Back does not pull the person out of Settings", async ({
  page,
}, info) => {
  test.skip(info.project.name.includes("mobile"), "wide layout");
  await seed(page);
  await page.getByRole("button", { name: /Welcome to your notes/ }).click();
  await expect(page).toHaveURL(/\/notes\/[A-Za-z0-9_-]+$/);
  const noteUrl = page.url();
  const notePath = new URL(noteUrl).pathname;
  // Start again with no note open while the address names it.
  await page.goto("/?fixture=1&session=stall");
  await expect(
    page.getByRole("button", { name: /Welcome to your notes/ }),
  ).toBeVisible();
  await page.evaluate((path) => {
    history.replaceState(null, "", path);
    type Harness = {
      store: { read: (...args: unknown[]) => Promise<unknown> };
    };
    const harness = (window as unknown as { __notesHarness: Harness })
      .__notesHarness;
    const read = harness.store.read.bind(harness.store);
    const held: (() => void)[] = [];
    (window as unknown as { releaseReads: () => void }).releaseReads = () =>
      held.splice(0).forEach((release) => release());
    harness.store.read = (...args) =>
      new Promise((resolve) => held.push(() => resolve(read(...args))));
  }, notePath);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/account$/);
  // Back to the notes: the address names a note, so it starts opening (held).
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await expect(page).toHaveURL(noteUrl);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/account$/);
  // An ordinary library refresh must not resume the open over Settings.
  await page.evaluate(() =>
    (
      window as unknown as {
        __notesHarness: { store: { notify: () => void } };
      }
    ).__notesHarness.store.notify(),
  );
  await page.waitForTimeout(300);
  await expect(
    page.getByRole("heading", { name: "Account", exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { releaseReads: () => void }).releaseReads(),
  );
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/\/settings\/account$/);
  await expect(
    page.getByRole("heading", { name: "Account", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await expect(page).toHaveURL(noteUrl);
  await expect(
    page.getByRole("textbox", { name: "Note content" }),
  ).toContainText("Opening it does not need a session token");
});
