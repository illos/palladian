import { createHash } from "node:crypto";
import type { Plugin } from "vite";
/** Only build-owned public assets enter the shell cache; never API/auth responses. */
export function offlineShell(): Plugin {
  return {
    name: "notes-offline-shell",
    enforce: "post",
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter((file) => !file.endsWith(".map"));
      const assets = [...new Set(["/", "/index.html", ...files.map((file) => "/" + file)])];
      const version = createHash("sha256").update(JSON.stringify(files)).digest("hex").slice(0, 16);
      const source = `const NAME = ${JSON.stringify("palladian-notes-shell-" + version)};
const ASSETS = ${JSON.stringify(assets)};
self.addEventListener('install', event => event.waitUntil(caches.open(NAME).then(cache => cache.addAll(ASSETS))));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !ASSETS.includes(url.pathname)) return;
  event.respondWith(caches.open(NAME).then(cache => cache.match(url.pathname)).then(hit => hit || fetch(event.request)));
});`;
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}
