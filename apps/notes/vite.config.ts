import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { offlineShell } from "./offline-plugin.ts";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

/** The commit a build comes from, shown in Settings → About; "dev" outside Git. */
function buildVersion() {
  try {
    const [commit, date] = execFileSync(
      "git",
      ["log", "-1", "--format=%h %cI"],
      { encoding: "utf8" },
    )
      .trim()
      .split(" ");
    return { commit: commit ?? "dev", date: date ?? null };
  } catch {
    return { commit: "dev", date: null };
  }
}
export default defineConfig(({ mode }) => {
  const env = loadEnv(
    mode,
    fileURLToPath(new URL("../..", import.meta.url)),
    "VITE_",
  );
  return {
    define: {
      __NOTES_DEV__: JSON.stringify(mode !== "production"),
      __NOTES_AUTH_SITE_URL__: JSON.stringify(
        env.VITE_NOTES_AUTH_SITE_URL ?? null,
      ),
      __NOTES_CONVEX_URL__: JSON.stringify(env.VITE_NOTES_CONVEX_URL ?? null),
      __NOTES_VERSION__: JSON.stringify(buildVersion()),
    },
    root: fileURLToPath(new URL(".", import.meta.url)),
    envDir: fileURLToPath(new URL("../..", import.meta.url)),
    plugins: [react(), offlineShell()],
    build: { target: ["chrome111", "firefox114", "safari16.4"] },
    server: {
      host: "127.0.0.1",
      port: 5178,
      strictPort: true,
      // Attachment bytes come from the Worker's /files routes (B1), which
      // runs separately in development (apps/notes-edge README).
      proxy: {
        "/files": process.env.NOTES_FILES_ORIGIN ?? "http://localhost:8787",
      },
    },
  };
});
