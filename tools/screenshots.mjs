#!/usr/bin/env node
// Regenerate the README screenshots from the fictional example family.
//
//   npm run build:web && node tools/screenshots.mjs            # writes docs/screenshots/*.png
//   CHROME=/path/to/chrome node tools/screenshots.mjs          # use an existing Chromium instead of Playwright's
//
// Runs the real Worker on example/ (tools/dev_server.mjs, no Cloudflare needed) and drives it with Playwright.
// Only the example family ever appears in these images; never point this at your own data.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startDevServer } from "./dev_server.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "screenshots");

// name, route, viewport, options
const SHOTS = [
  ["home", "#/", { width: 1280, height: 800 }],
  ["home-dark", "#/", { width: 1280, height: 800 }, { dark: true }],
  ["tree", "#/tree", { width: 1280, height: 800 }],
  ["person", "#/person/I5", { width: 1280, height: 800 }],
  ["story", "#/story/eva-comes-to-england", { width: 1280, height: 800 }],
  ["map", "#/map", { width: 1280, height: 800 }, { wait: 2500 }],
  ["research", "#/research/findings", { width: 1280, height: 800 }],
  ["search", "#/search?q=novak", { width: 1280, height: 800 }],
  ["mobile-home", "#/", { width: 390, height: 844 }, { mobile: true }],
  ["mobile-person", "#/person/I5", { width: 390, height: 844 }, { mobile: true }],
];

const server = await startDevServer({ port: 0, quiet: true });
const base = `${server.url}/`;
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
mkdirSync(OUT, { recursive: true });
const errors = [];
try {
  for (const [name, route, viewport, opt = {}] of SHOTS) {
    const ctx = await browser.newContext({
      viewport, deviceScaleFactor: 2, colorScheme: opt.dark ? "dark" : "light",
      isMobile: !!opt.mobile, hasTouch: !!opt.mobile,
    });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
    await page.goto(base + route, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(opt.wait || 800);
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    await ctx.close();
    console.log(`screenshots: docs/screenshots/${name}.png`);
  }
} finally {
  await browser.close();
  await server.close();
}
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
