// Records a short product tour of the running app and encodes it to an animated GIF.
//
//   node scripts/makeDemoGif.mjs
//
// The app must be running first (start-app.cmd, or db:start + api + dev).
// Output: public/demo.gif
//
// Frames are real screenshots of the real UI - nothing is mocked up. Each "beat" of the tour
// holds for a number of frames so a reader can actually read the screen before it moves on.

import { chromium } from "playwright";
import { PNG } from "pngjs";
import { mkdirSync, writeFileSync } from "node:fs";
import gifencPkg from "gifenc";

// gifenc ships as CJS, so the named helpers hang off the default import.
const { GIFEncoder, quantize, applyPalette } = gifencPkg;

const URL = process.env.APP_URL || "http://localhost:5173";
const OUT = "public/demo.gif";

// Capture at 2x the output size and downscale in the browser-independent step below: sharper
// text than capturing directly at the small size.
const VIEW = { width: 1280, height: 780 };
const SCALE = 0.7; // final GIF is 896x546
const FPS = 10;

const frames = [];

async function shoot(page, times = 1) {
  for (let i = 0; i < times; i++) {
    frames.push(await page.screenshot({ type: "png" }));
    if (times > 1) await page.waitForTimeout(60);
  }
}

// A caption bar drawn into the page itself, so the GIF explains what it is showing.
async function caption(page, text) {
  await page.evaluate((t) => {
    let el = document.getElementById("__demo_caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "__demo_caption";
      Object.assign(el.style, {
        position: "fixed", left: "0", right: "0", bottom: "0", zIndex: "2147483647",
        background: "linear-gradient(90deg, #0f766e 0%, #0d9488 60%, #14b8a6 100%)",
        color: "#fff", font: "600 15px/1 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif",
        padding: "13px 20px", letterSpacing: ".01em",
        boxShadow: "0 -6px 20px rgba(15,23,42,.18)",
      });
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });
const page = await ctx.newPage();

console.log("recording tour ...");

// ---- 1. Sign in ----
await page.goto(URL, { waitUntil: "networkidle" });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "networkidle" });
await caption(page, "Secure sign-in with role-based access");
await shoot(page, 8);

await page.fill('input[type="email"]', "admin@medbill.local");
await shoot(page, 3);
await page.fill('input[type="password"]', "Admin@12345");
await shoot(page, 3);
await page.click('button[type="submit"]');
await page.waitForSelector("text=Dashboard", { timeout: 30000 });
await page.waitForTimeout(1200);

// ---- 2. Dashboard ----
await caption(page, "Dashboard - outstanding balances, revenue and claim status at a glance");
await shoot(page, 14);

// ---- 3. Patients ----
await page.getByRole("button", { name: "Patients", exact: true }).click().catch(() => page.click("text=Patients"));
await page.waitForSelector("table tbody tr", { timeout: 15000 });
await caption(page, "Patient records - 122 charts, searchable");
await shoot(page, 8);

const search = page.locator('input[placeholder*="Search"]').first();
if (await search.count()) {
  for (const s of ["M", "Ma", "Mar", "Mari"]) { await search.fill(s); await page.waitForTimeout(120); await shoot(page); }
  await shoot(page, 6);
  await search.fill("");
  await page.waitForTimeout(400);
}

// ---- 4. A patient chart ----
await page.locator("table tbody tr").first().click();
await page.waitForTimeout(1400);
await caption(page, "Full chart - demographics, insurance history, memos and documents");
await shoot(page, 12);

for (const tab of ["Insurance", "Claim"]) {
  const t = page.locator(`text=${tab}`).first();
  if (await t.isVisible().catch(() => false)) {
    await t.click().catch(() => {});
    await page.waitForTimeout(900);
    await caption(page, tab === "Insurance"
      ? "Insurance is versioned - previous coverage is never overwritten"
      : "Per-procedure charge ledger with payments, write-offs and adjustments");
    await shoot(page, 12);
  }
}

// ---- 5. Reports ----
await page.getByRole("button", { name: "Reports", exact: true }).click().catch(() => page.click("text=Reports"));
await page.waitForSelector("text=Revenue trend", { timeout: 15000 });
await page.waitForTimeout(800);
await caption(page, "Reporting - revenue trend and claims by status");
await shoot(page, 12);

await page.click("text=Report center");
await page.waitForTimeout(900);
await caption(page, "Aging, debit and credit reports - export to CSV or print");
await shoot(page, 10);

// ---- 6. Daily Transaction report ----
await page.click('button:has-text("Daily Transaction")');
await page.waitForSelector("text=Daily Transaction Report", { timeout: 10000 });
await page.waitForTimeout(600);
await caption(page, "Daily Transaction report - filter by date, doctor, user, batch or CPT");
await shoot(page, 12);

const modal = page.locator(".fixed.inset-0").last();
const dates = modal.locator('input[type="date"]');
await dates.nth(0).fill("2026-08-01");
await shoot(page, 2);
await dates.nth(1).fill("2026-09-30");
await shoot(page, 2);
await modal.getByRole("button", { name: "Generate Report" }).click();
await page.waitForSelector("text=Report preview", { timeout: 20000 });
await page.waitForTimeout(700);
await caption(page, "Live preview, totals, then export or print the same dataset");
await shoot(page, 10);

// Scroll the preview into view so the table and summary are visible.
await modal.evaluate((el) => el.scrollBy({ top: 420, behavior: "smooth" })).catch(() => {});
await page.waitForTimeout(900);
await shoot(page, 14);

await browser.close();
console.log(`captured ${frames.length} frames`);

// ---- encode ----
console.log("encoding GIF ...");

// Nearest-neighbour box downscale of an RGBA buffer. Averaging over the source box keeps text
// legible at 0.7x far better than picking a single pixel.
function downscale(src, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const xr = sw / dw, yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.floor(y * yr), sy1 = Math.min(sh, Math.ceil((y + 1) * yr));
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.floor(x * xr), sx1 = Math.min(sw, Math.ceil((x + 1) * xr));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * sw + sx) * 4;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; n++;
        }
      }
      const o = (y * dw + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return out;
}

const gif = GIFEncoder();
const dw = Math.round(VIEW.width * SCALE);
const dh = Math.round(VIEW.height * SCALE);
const delay = Math.round(1000 / FPS);

// The tour deliberately holds still on each screen so it can be read, which means long runs of
// identical frames. Writing each one separately triples the file size for no visual gain, so
// identical consecutive frames are collapsed into a single frame with a longer delay instead.
function hash(buf) {
  let h = 2166136261;
  for (let i = 0; i < buf.length; i += 97) {
    h ^= buf[i];
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

let pending = null; // { index, palette, delay }
let written = 0;

for (let i = 0; i < frames.length; i++) {
  const png = PNG.sync.read(frames[i]);
  const small = downscale(png.data, png.width, png.height, dw, dh);
  const h = hash(small);

  if (pending && pending.hash === h) {
    pending.delay += delay;
  } else {
    if (pending) {
      gif.writeFrame(pending.index, dw, dh, { palette: pending.palette, delay: pending.delay });
      written++;
    }
    // A per-frame palette keeps the teal UI and the chart colours clean; 192 colours leaves
    // headroom in the tables without the file ballooning.
    const palette = quantize(small, 192, { format: "rgb565" });
    const index = applyPalette(small, palette, "rgb565");
    pending = { index, palette, delay, hash: h };
  }
  if (i % 20 === 0) process.stdout.write(`  ${i}/${frames.length}\r`);
}
if (pending) {
  gif.writeFrame(pending.index, dw, dh, { palette: pending.palette, delay: pending.delay });
  written++;
}
gif.finish();
console.log(`\n${frames.length} captured -> ${written} unique frames after collapsing holds`);

mkdirSync("public", { recursive: true });
const bytes = gif.bytes();
writeFileSync(OUT, bytes);
console.log(`\nwrote ${OUT}  ${dw}x${dh}  ${frames.length} frames  ${(bytes.length / 1048576).toFixed(2)} MB`);
