// End-to-end smoke tests: every page of the site in a real browser, against the real Worker on the fictional example
// family (tools/dev_server.mjs). Each page must render its key content without a JavaScript error.
//
//   npm run test:e2e                 the built site (dist/site; run `npm run build:web` first)
//   E2E_SITE=site npm run test:e2e   another folder of static files
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startDevServer } from "../tools/dev_server.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = resolve(ROOT, process.env.E2E_SITE || "dist/site");
let srv, browser, page, errors = [];

before(async () => {
  srv = await startDevServer({ port: 8799, site: SITE, quiet: true });
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|tile|leaflet|unpkg|fonts\.g/i.test(m.text())) errors.push(`console: ${m.text()}`); });
  await page.goto(`${srv.url}/#/`);
  await page.waitForSelector("#app h1, #app h2, main h1", { timeout: 15000 });
});
after(async () => { await browser?.close(); await srv?.close(); });

/** Go to a route and wait for text to appear in the page; fail on any script error along the way. */
async function visit(hash, expect, { selector = "body" } = {}) {
  errors = [];
  await page.evaluate((h) => { location.hash = h; }, hash);
  for (const t of [].concat(expect)) {
    await page.waitForFunction(([sel, text]) => (document.querySelector(sel) || document.body).innerText.includes(text), [selector, t], { timeout: 8000 })
      .catch(() => { throw new Error(`"${t}" didn't appear on ${hash}`); });
  }
  await page.waitForTimeout(150);
  assert.deepEqual(errors, [], `no script errors on ${hash}`);
}
const title = () => page.title();

test("home", async () => {
  await visit("#/", ["Hartley"]);
  assert.match(await title(), /Family History/);
});
test("people list and search", async () => {
  await visit("#/people", ["Eva Novák", "George Hartley"]);
  await page.fill("#search", "Eva");
  await page.waitForFunction(() => document.querySelector("#search-results").innerText.includes("Eva Novák"), null, { timeout: 5000 });
  await page.fill("#search", "");
});
test("person page", async () => {
  await visit("#/person/I5", ["Eva Novák", "Life events", "Eva comes to England"]);
  assert.match(await title(), /Eva Novák/);
  await visit("#/person/I4", ["George Hartley", "Mentioned in"]);
});
test("person page: close-family events and their toggle", async () => {
  await visit("#/person/I4", ["Life events", "Son born:", "Father died:"]);
  const timeline = () => page.locator(".timeline-list").innerText();
  assert.doesNotMatch(await timeline(), /Brother born/, "a brother born before him is left out");
  await page.getByLabel("Family events").uncheck();
  assert.doesNotMatch(await timeline(), /Son born:|Father died:/, "the toggle hides family events");
  await page.reload();
  await page.waitForSelector(".timeline-list");
  assert.equal(await page.getByLabel("Family events").isChecked(), false, "the choice survives a reload");
  assert.doesNotMatch(await timeline(), /Son born:/);
  await page.getByLabel("Family events").check();
  assert.match(await timeline(), /Son born:/);
  assert.deepEqual(errors, []);
});
test("family tree chart", async () => {
  await visit("#/tree/I1", ["Ancestors"]);
  assert.ok(await page.locator("svg").count() > 0, "the chart draws");
});
test("branch", async () => { await visit("#/branch/novak", ["Direct ancestors"]); });
test("stories and a story", async () => {
  await visit("#/stories", ["Stories", "Eva comes to England"]);
  await visit("#/story/eva-comes-to-england", ["Eva comes to England", "Sources"]);
  assert.ok(await page.locator('a[href="#/person/I5"]').count() > 0, "people in the story are linked");
});
test("map and timeline", async () => {
  await visit("#/map", ["Map"]);
  await visit("#/timeline", ["Timeline"]);
});
test("research tabs", async () => {
  await visit("#/research", ["Research"]);
  await visit("#/research/findings", ["Findings"]);
  await visit("#/research/todo", ["To-do"]);
  await visit("#/research/queue", ["Suggestions"]);
});
test("admin and audit history (owner)", async () => {
  await visit("#/admin", ["People and access", "Views"]);
  await visit("#/admin/audit", ["Audit history"]);
  await page.locator(".audit-row").first().click();
  await page.locator(".audit-detail").first().waitFor({ timeout: 5000 });
  assert.deepEqual(errors, []);
});
test("about and not found", async () => {
  await visit("#/about", ["How this site works"]);
  await visit("#/no-such-page", ["Not found"]);
});
