import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig(({ mode }) => {
  const env = loadEnv(
    mode,
    fileURLToPath(new URL("../..", import.meta.url)),
    "VITE_",
  );
  return {
    define: {
      __PALLADIAN_CONFIG__: JSON.stringify({
        dataUrl: env.VITE_CONVEX_URL ?? "",
        authUrl: env.VITE_CONVEX_SITE_URL ?? "",
      }),
    },
    root: fileURLToPath(new URL(".", import.meta.url)),
    envDir: fileURLToPath(new URL("../..", import.meta.url)),
    plugins: [react()],
    build: {
      target: ["chrome111", "edge111", "firefox114", "safari16.4"],
      manifest: true,
    },
    server: { host: "127.0.0.1", port: 5173, strictPort: true },
    preview: { host: "127.0.0.1", port: 4173, strictPort: true },
  };
});
