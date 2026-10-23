import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
export default defineConfig({
  testDir: "../../tests/browser",
  testMatch: [
    "notes-foundation.spec.ts",
    "notes-design.spec.ts",
    "notes-settings.spec.ts",
    "notes-actions.spec.ts",
    "notes-swipe.spec.ts",
    "notes-editor.spec.ts",
    "notes-files-gate.spec.ts",
    "notes-history.spec.ts",
    "notes-notebooks.spec.ts",
    "notes-attachments.spec.ts",
  ],
  fullyParallel: true,
  reporter: "list",
  use: { baseURL: "http://localhost:5178", trace: "off" },
  webServer: {
    command: "pnpm exec vite --config apps/notes/vite.config.ts",
    url: "http://localhost:5178",
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    reuseExistingServer: false,
  },
  projects: [
    { name: "notes-chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "notes-mobile-chromium",
      use: {
        ...devices["iPhone 15 Plus"],
        defaultBrowserType: "chromium",
        browserName: "chromium",
      },
    },
    { name: "notes-mobile-webkit", use: { ...devices["iPhone 15 Plus"] } },
  ],
});
