import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
export default defineConfig({
  testDir: "../../tests/browser",
  testMatch: "notes-offline.spec.ts",
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:5181", trace: "off" },
  webServer: {
    command:
      "./node_modules/.bin/vite build --config apps/notes/vite.config.ts && ./node_modules/.bin/vite preview --config apps/notes/vite.config.ts --host 127.0.0.1 --port 5181 --strictPort",
    url: "http://127.0.0.1:5181",
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    reuseExistingServer: false,
  },
  projects: [
    {
      name: "notes-offline-desktop-chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
