import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
const root = "apps/web/dist/";
const manifest = JSON.parse(readFileSync(root + ".vite/manifest.json", "utf8"));
const eager = new Set();
function walk(key) {
  if (eager.has(key)) return;
  assert(manifest[key], `Missing chunk ${key}`);
  eager.add(key);
  for (const child of manifest[key].imports ?? []) walk(child);
}
walk("index.html");
const apps = ["src/apps/notes/entry.tsx", "src/apps/recipes/entry.tsx"];
for (const app of apps) {
  assert(manifest[app]?.isDynamicEntry, `${app} must be a dynamic entry`);
  assert(!eager.has(app), `${app} must not be eager`);
}
const html = readFileSync(root + "index.html", "utf8");
for (const app of apps)
  assert(
    !html.includes(manifest[app].file),
    "Inactive app preloaded from HTML",
  );
let bytes = gzipSync(readFileSync(root + "theme-init.js")).length;
for (const key of eager)
  if (manifest[key].file.endsWith(".js"))
    bytes += gzipSync(readFileSync(root + manifest[key].file)).length;
assert(bytes <= 200 * 1024, `Eager JavaScript ${bytes} exceeds 200KiB`);
console.log(
  JSON.stringify(
    {
      eager: [...eager],
      lazy: apps.map((key) => ({ entry: key, file: manifest[key].file })),
      eagerJavaScriptGzipBytes: bytes,
      budgetBytes: 200 * 1024,
      limitation:
        "P0 shell only; auth client cost must be added and remeasured in P1",
    },
    null,
    2,
  ),
);
