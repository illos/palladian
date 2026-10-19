// Renders the app icon PNGs and favicon.ico from their SVG sources with
// Playwright Chromium. Run after editing icons/*.svg or public/icon.svg:
//   node apps/notes/scripts/icons.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../package.json", import.meta.url));
const { chromium } = require("@playwright/test");
const read = (path) => readFileSync(new URL("../" + path, import.meta.url));
const write = (name, bytes) => {
  writeFileSync(new URL("../public/" + name, import.meta.url), bytes);
  console.log("✓ public/" + name);
};

const browser = await chromium.launch();
const page = await browser.newPage({ colorScheme: "light" });
async function render(path, size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>*{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>` +
      read(path).toString("utf8"),
  );
  return page.screenshot({ omitBackground: true });
}

/** An ICO whose entries are PNG images, supported by every current browser. */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    const entry = 6 + 16 * index;
    header.writeUInt8(size, entry);
    header.writeUInt8(size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(({ png }) => png)]);
}

try {
  write("apple-touch-icon.png", await render("icons/app-icon.svg", 180));
  write("icon-192.png", await render("icons/app-icon.svg", 192));
  write("icon-512.png", await render("icons/app-icon.svg", 512));
  write(
    "icon-maskable-512.png",
    await render("icons/app-icon-maskable.svg", 512),
  );
  const favicons = [];
  for (const size of [16, 32, 48])
    favicons.push({ size, png: await render("public/icon.svg", size) });
  write("favicon.ico", ico(favicons));
} finally {
  await browser.close();
}
