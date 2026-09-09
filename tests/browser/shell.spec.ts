import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const manifest = JSON.parse(
  readFileSync("apps/web/dist/.vite/manifest.json", "utf8"),
) as Record<string, { file: string }>;
const notes = manifest["src/apps/notes/entry.tsx"]!.file;
const recipes = manifest["src/apps/recipes/entry.tsx"]!.file;
test("shell loads without backend and loads only requested app", async ({
  page,
}) => {
  const requested: string[] = [];
  page.on("request", (req) => requested.push(req.url()));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Everything in its place." }),
  ).toBeVisible();
  expect(
    requested.some((url) => url.includes(notes) || url.includes(recipes)),
  ).toBe(false);
  expect(
    requested.every((url) => new URL(url).origin === "http://127.0.0.1:4173"),
  ).toBe(true);
  await page
    .getByRole("button", { name: /Notes.*Explore empty preview/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Room for your next idea." }),
  ).toBeVisible();
  expect(requested.some((url) => url.includes(notes))).toBe(true);
  expect(requested.some((url) => url.includes(recipes))).toBe(false);
  await page.getByRole("button", { name: "All apps" }).click();
  await page
    .getByRole("button", { name: /Recipes.*Explore empty preview/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Something worth making again." }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("theme persists across reload and unavailable storage does not block shell", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Theme").selectOption("dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("Storage unavailable");
      },
    });
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Everything in its place." }),
  ).toBeVisible();
  await page.getByLabel("Theme").selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});
test("failed lazy app preserves navigation", async ({ page }) => {
  await page.route(`**/${notes}`, (route) => route.abort());
  await page.goto("/");
  await page
    .getByRole("button", { name: /Notes.*Explore empty preview/ })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "This app couldn’t open.",
  );
  await page.getByRole("button", { name: "All apps" }).click();
  await expect(
    page.getByRole("heading", { name: "Everything in its place." }),
  ).toBeVisible();
});
