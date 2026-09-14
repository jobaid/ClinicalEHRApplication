// Generates the manager's icons from one SVG source.
//
// A stethoscope on a teal rounded square - a clinical mark rather than a
// generic developer gear, since this sits in the system tray of a clinic's
// machine all day.
//
// Playwright is used purely as a rasteriser: it is already a dependency of the
// parent project for its browser tests, and it is the only thing here that can
// turn an SVG into a PNG without adding an image library. Run once:
//
//   npm run icons
//
// Outputs build/tray.png (16/32 for the tray), build/icon.png (512, for the
// window) and build/icon.ico (multi-size, required by electron-builder).

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.join(here, "..", "build");
fs.mkdirSync(buildDir, { recursive: true });

const svg = (size, bg) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
  ${bg ? '<rect width="64" height="64" rx="14" fill="#0f8a80"/>' : ""}
  <g fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M20 14v12a12 12 0 0 0 24 0V14"/>
    <path d="M20 14h-5M44 14h5"/>
    <path d="M32 38v5a9 9 0 0 0 9 9"/>
    <circle cx="47" cy="47" r="6"/>
  </g>
</svg>`;

async function render(page, size, bg, out) {
  const markup = svg(size, bg);
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<body style="margin:0;background:transparent">${markup}</body>`,
    { waitUntil: "load" }
  );
  await page.screenshot({ path: out, omitBackground: true });
  console.log("  wrote", path.relative(process.cwd(), out));
}

/**
 * Builds a .ico from PNG payloads.
 *
 * The ICO container is simple enough to write by hand: a 6-byte header, a
 * 16-byte directory entry per image, then the PNG bytes. Windows has accepted
 * PNG-compressed entries since Vista, so no BMP encoding is needed - which is
 * what makes this a few lines instead of an image library.
 */
function buildIco(pngPaths, outPath) {
  const images = pngPaths.map(({ size, file }) => ({ size, data: fs.readFileSync(file) }));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);            // reserved
  header.writeUInt16LE(1, 2);            // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;

  for (const img of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 0);  // 0 means 256
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 1);
    e.writeUInt8(0, 2);                  // palette
    e.writeUInt8(0, 3);                  // reserved
    e.writeUInt16LE(1, 4);               // colour planes
    e.writeUInt16LE(32, 6);              // bits per pixel
    e.writeUInt32LE(img.data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += img.data.length;
  }

  fs.writeFileSync(outPath, Buffer.concat([header, ...entries, ...images.map((i) => i.data)]));
  console.log("  wrote", path.relative(process.cwd(), outPath));
}

const browser = await chromium.launch();
const page = await browser.newPage();

// Tray icons are small and sit on the taskbar, so they keep the teal tile for
// contrast against both light and dark taskbars.
await render(page, 16, true, path.join(buildDir, "tray.png"));
await render(page, 32, true, path.join(buildDir, "tray@2x.png"));

const icoSizes = [16, 32, 48, 64, 128, 256];
const icoParts = [];
for (const size of icoSizes) {
  const file = path.join(buildDir, `icon-${size}.png`);
  await render(page, size, true, file);
  icoParts.push({ size, file });
}
await render(page, 512, true, path.join(buildDir, "icon.png"));

await browser.close();

buildIco(icoParts, path.join(buildDir, "icon.ico"));

// The per-size PNGs existed only to be folded into the .ico.
for (const { file } of icoParts) fs.unlinkSync(file);

console.log("Icons generated.");
