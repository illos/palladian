import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import type { Plugin } from "vite";
/** Only build-owned public assets enter the shell cache; never API/auth responses. */
export function offlineShell(): Plugin {
  return {
    name: "notes-offline-shell",
    enforce: "post",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return html.replace(
          '<script id="notes-theme-bootstrap"></script>',
          '<script id="notes-theme-bootstrap">' +
            readFileSync(
              new URL("./public/theme-bootstrap.js", import.meta.url),
              "utf8",
            ) +
            "</script>",
        );
      },
    },
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter(
        (file) => !file.endsWith(".map"),
      );
      // The PDF reader with pdf.js and its worker (plan 08 B4) load when a
      // PDF opens; every device need not fetch them with each update.
      const reader = new Set<string>();
      for (const [file, item] of Object.entries(bundle))
        if (item.type === "chunk") {
          if (!item.moduleIds.some((id) => id.includes("/pdfjs-dist/")))
            continue;
          reader.add(file);
          for (const css of item.viteMetadata?.importedCss ?? [])
            reader.add(css);
        } else if (
          item.originalFileNames.some((name) => name.includes("/pdfjs-dist/"))
        )
          reader.add(file);
      const assets = [
        ...new Set([
          "/",
          "/index.html",
          "/manifest.webmanifest",
          "/theme-bootstrap.js",
          ...readdirSync(new URL("./public/fonts/", import.meta.url))
            .filter((file) => file.endsWith(".woff2"))
            .sort()
            .map((file) => "/fonts/" + file),
          ...files
            .filter((file) => !reader.has(file))
            .map((file) => "/" + file),
        ]),
      ];
      const digest = createHash("sha256");
      digest.update(
        readFileSync(new URL("./public/manifest.webmanifest", import.meta.url)),
      );
      for (const path of assets.filter(
        (path) => path.startsWith("/fonts/") || path === "/theme-bootstrap.js",
      ))
        digest
          .update(path)
          .update(readFileSync(new URL("./public" + path, import.meta.url)));
      for (const file of files.sort()) {
        const item = bundle[file];
        if (!item) throw new Error("Build asset missing");
        digest
          .update(file)
          .update(item.type === "chunk" ? item.code : item.source);
      }
      const version = digest.digest("hex").slice(0, 16);
      const source = serviceWorkerSource(version, assets);
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

/**
 * The service worker for one build. A new build installs in the background and
 * takes over once no window runs the previous one; it then removes the older
 * builds' files.
 */
export function serviceWorkerSource(version: string, assets: string[]): string {
  return `const NAME = ${JSON.stringify("palladian-notes-shell-" + version)};
const ASSETS = ${JSON.stringify(assets)};
self.addEventListener('install', event => event.waitUntil(caches.open(NAME).then(cache => cache.addAll(ASSETS))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('palladian-notes-shell-') && key !== NAME).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.search || event.request.headers.has('authorization') || url.origin !== self.location.origin) return;
  // Note and Settings deep links open the cached shell; the app reads the note from the local cache.
  if (event.request.mode === 'navigate' && (/^\\/notes\\/[A-Za-z0-9_-]+$/.test(url.pathname) || /^\\/settings(\\/[a-z]+)?$/.test(url.pathname))) {
    event.respondWith(caches.open(NAME).then(cache => cache.match('/')).then(hit => hit || fetch(event.request)));
    return;
  }
  if (!ASSETS.includes(url.pathname)) return;
  event.respondWith(caches.open(NAME).then(cache => cache.match(url.pathname)).then(hit => hit || fetch(event.request)));
});`;
}
