import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  envDir: fileURLToPath(new URL("../..", import.meta.url)),
  plugins: [react()],
  build: { target: ["chrome111", "firefox114", "safari16.4"] },
  server: { host: "127.0.0.1", port: 5174, strictPort: true },
});
