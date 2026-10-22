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
  await expect(page.getByRole("button", { name: "Update now" })).toBeVisible();
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
