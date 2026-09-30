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
          ...files.map((file) => "/" + file),
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
      const source = `const NAME = ${JSON.stringify("palladian-notes-shell-" + version)};
const ASSETS = ${JSON.stringify(assets)};
self.addEventListener('install', event => event.waitUntil(caches.open(NAME).then(cache => cache.addAll(ASSETS))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('palladian-notes-shell-') && key !== NAME).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.search || event.request.headers.has('authorization') || url.origin !== self.location.origin || !ASSETS.includes(url.pathname)) return;
  event.respondWith(caches.open(NAME).then(cache => cache.match(url.pathname)).then(hit => hit || fetch(event.request)));
});`;
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}
