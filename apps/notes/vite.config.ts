import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig(({ mode }) => ({
  define: {
    __NOTES_DEV__: JSON.stringify(mode !== "production"),
    __NOTES_AUTH_SITE_URL__: JSON.stringify(
      loadEnv(mode, fileURLToPath(new URL("../..", import.meta.url)), "VITE_")
        .VITE_NOTES_AUTH_SITE_URL ?? null,
    ),
  },
  root: fileURLToPath(new URL(".", import.meta.url)),
  envDir: fileURLToPath(new URL("../..", import.meta.url)),
  plugins: [react()],
  build: { target: ["chrome111", "firefox114", "safari16.4"] },
  server: { host: "127.0.0.1", port: 5178, strictPort: true },
}));
