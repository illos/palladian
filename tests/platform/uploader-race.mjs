import { frontendOrigin } from "../auth/environment.mjs";
import { chromium, expect } from "@playwright/test";
const browser = await chromium.launch();
const modulePath = `/@fs/${process.cwd()}/tests/platform/uploader-fixture.jsx`;
let scenario = "mount";
try {
  const page = await browser.newPage();
  await page.goto(frontendOrigin);
  await page.evaluate(async (path) => (await import(path)).mount(), modulePath);
  const file = (name) => ({
    name,
    mimeType: "text/plain",
    buffer: Buffer.from("fixture bytes"),
  });
  const state = () =>
    page.evaluate(async (path) => (await import(path)).state(), modulePath);
  const release = (name) =>
    page.evaluate(
      async ({ path, name }) => (await import(path)).release(name),
      { path: modulePath, name },
    );
  scenario =
    "cancel returns immediately while old request and cleanup remain pending";
  await page
    .getByLabel("Choose file", { exact: true })
    .setInputFiles(file("old.txt"));
  await page.getByRole("button", { name: "Upload file", exact: true }).click();
  await expect.poll(async () => (await state()).pending).toContain("old.txt");
  await page
    .getByRole("button", { name: "Cancel upload", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Transfer stopped.");
  await expect(page.getByLabel("Choose file", { exact: true })).toBeEnabled();
  await page
    .getByLabel("Choose file", { exact: true })
    .setInputFiles(file("new.txt"));
  await page.getByRole("button", { name: "Upload file", exact: true }).click();
  await expect.poll(async () => (await state()).pending).toContain("new.txt");
  await release("old.txt");
  await expect
    .poll(async () => (await state()).cancelled)
    .toContainEqual({ id: "old.txt", scope: "first" });
  await expect(page.getByRole("status")).toHaveText("Preparing upload…");
  await expect(
    page.getByRole("button", { name: "Cancel upload", exact: true }),
  ).toBeEnabled();
  await release("new.txt");
  await expect(page.getByRole("status")).toHaveText("File verified and ready.");
  await expect(page.getByLabel("Choose file", { exact: true })).toHaveValue("");
  console.log(`PASS ${scenario}`);
  scenario = "scope unmount aborts old intent without touching the new scope";
  await page
    .getByLabel("Choose file", { exact: true })
    .setInputFiles(file("scope-old.txt"));
  await page.getByRole("button", { name: "Upload file", exact: true }).click();
  await expect
    .poll(async () => (await state()).pending)
    .toContain("scope-old.txt");
  await page.evaluate(
    async (path) => (await import(path)).switchScope(),
    modulePath,
  );
  await page
    .getByLabel("Choose file", { exact: true })
    .setInputFiles(file("scope-new.txt"));
  await page.getByRole("button", { name: "Upload file", exact: true }).click();
  await expect
    .poll(async () => (await state()).pending)
    .toContain("scope-new.txt");
  await release("scope-old.txt");
  await expect
    .poll(async () => (await state()).cancelled)
    .toContainEqual({ id: "scope-old.txt", scope: "first" });
  await expect(page.getByRole("status")).toHaveText("Preparing upload…");
  await release("scope-new.txt");
  await expect(page.getByRole("status")).toHaveText("File verified and ready.");
  console.log(`PASS ${scenario}`);
  console.log(
    "Two actual Chromium component/driver race cases passed with mocked request/finalize/cancel; this does not prove R2 or server cleanup.",
  );
} catch (error) {
  const locations =
    typeof error?.stack === "string"
      ? error.stack.match(/tests\/platform\/uploader-race\.mjs:\d+:\d+/g)
      : null;
  if (locations) console.error([...new Set(locations)].join("\n"));
  console.error(`FAIL ${scenario}; private details suppressed.`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
