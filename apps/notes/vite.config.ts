import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { offlineShell } from "./offline-plugin.ts";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { cpSync, createReadStream, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";

/**
 * pdf.js's data files for the PDF reader (plan 08 B4): CMaps, standard
 * fonts, image decoders and ICC profiles, served from the app's own origin
 * at /pdfjs/ (never a CDN), in development and in the build. Written after
 * the bundle, so the offline shell does not precache them. QuickJS, the
 * engine pdf.js would run a PDF's JavaScript with, is never served.
 */
function pdfjsAssets(): Plugin {
  const root = dirname(
    createRequire(import.meta.url).resolve("pdfjs-dist/package.json"),
  );
  const folders = ["cmaps", "standard_fonts", "wasm", "iccs"];
  const served = (folder: string, file: string) =>
    !(folder === "wasm" && file.startsWith("quickjs"));
  const types: Record<string, string> = {
    ".wasm": "application/wasm",
    ".js": "text/javascript",
  };
  return {
    name: "notes-pdfjs-assets",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const match =
          /^\/pdfjs\/(cmaps|standard_fonts|wasm|iccs)\/([\w.-]+)$/.exec(
            (request.url ?? "").split("?")[0]!,
          );
        if (!match || !served(match[1]!, match[2]!)) return next();
        const file = join(root, match[1]!, match[2]!);
        if (!existsSync(file)) return next();
        response.setHeader(
          "Content-Type",
          types[/\.\w+$/.exec(file)?.[0] ?? ""] ?? "application/octet-stream",
        );
        createReadStream(file).pipe(response);
      });
    },
    writeBundle(options) {
      if (!options.dir) return;
      for (const folder of folders)
        cpSync(join(root, folder), join(options.dir, "pdfjs", folder), {
          recursive: true,
          filter: (source) => served(folder, basename(source)),
        });
    },
  };
}

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
    plugins: [react(), offlineShell(), pdfjsAssets()],
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
