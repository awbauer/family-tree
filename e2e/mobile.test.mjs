// Phone-sized checks: with very long names, places and links in the tree, no page is wider than the screen, and the
// page assistant opens as a full-screen sheet that fits. Fictional example family plus invented long text.
// Runs in Chromium and, when it's installed (`npx playwright install webkit`), in WebKit, which is what iPhone Safari
// uses: Safari wraps text differently enough that a page can fit in Chromium and still overflow on a phone.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { existsSync } from "node:fs";
import { startDevServer } from "../tools/dev_server.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = resolve(ROOT, process.env.E2E_SITE || "dist/site");
const LONG = "Bartholomewmaximilianchristophersonwellingtonfeatherstonehaugh";
const LINK = "https://records.example.org/collections/parish-registers/volume-123/page-456/entry-789?image=abcdefghijklmnopqrstuvwxyz0123456789";
let srv, browsers = [], pages = [], longId, errors = [];

before(async () => {
  srv = await startDevServer({ port: 0, site: SITE, quiet: true });
  const api = async (m, p, b) => {
    const r = await fetch(`${srv.url}/api/${p}`, { method: m, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined });
    const j = await r.json(); if (!r.ok) throw new Error(`${p}: ${j.error}`); return j;
  };
  const tree = (await api("GET", "me")).trees[0].id;
  const fam = (await api("GET", `tree?tree=${tree}`)).people.I5.fams[0];
  await api("POST", "edit", { tree, reason: "long text for the phone checks", ops: [
    { op: "person.create", id: "$p", names: [{ given: `Maximiliana ${LONG}`, surname: `${LONG}-Exampleton` }], sex: "F",
      events: [{ type: "Birth", date: "3 Mar 1962", place: `Little ${LONG} upon the Marsh, Exampleshire` }, { type: "Occupation", value: `Senior ${LONG} administrator` }] },
    { op: "family.add_child", family: fam, person: "$p" },
    { op: "source.upsert", id: "S99", data: { title: `The ${LONG} register`, url: LINK, repository: `${LONG} Record Office` } },
    { op: "event.add", entity: "person", id: "I5", event: { type: "Residence", date: "1950", place: `${LONG} Street`, citations: [{ source: "S99", url: LINK }] } },
  ] });
  await api("POST", "comments", { tree, type: "person", id: "I5", body: `See ${LINK} ${LONG}${LONG}` });
  await api("POST", "todos", { tree, task: `Find the ${LONG} record at ${LINK}`, person: "I5", priority: "high" });
  const people = (await api("GET", `tree?tree=${tree}`)).people;
  longId = Object.keys(people).find((k) => people[k].name.startsWith("Maximiliana"));

  const engines = [chromium, ...(existsSync(webkit.executablePath()) ? [webkit] : [])];
  if (engines.length === 1) console.log("mobile tests: WebKit isn't installed (npx playwright install webkit); running in Chromium only");
  for (const engine of engines) {
    const browser = await engine.launch();
    browsers.push(browser);
    const page = await (await browser.newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true })).newPage();
    page.engine = engine.name();
    pages.push(page);
    await setUp(page);
  }
}, { timeout: 90_000 });
after(async () => { for (const b of browsers) await b.close(); await srv?.close(); }, { timeout: 30_000 });

async function setUp(page) {
  page.on("pageerror", (e) => errors.push(`${page.engine}: ${e.message}`));
  await page.route(/\/api\/me(\?|$)/, async (route) => { const r = await route.fetch(); route.fulfill({ response: r, json: { ...(await r.json()), ai: true } }); });
  await page.route(/\/api\/chat/, (route) => {
    const u = new URL(route.request().url());
    if (route.request().method() === "POST" && u.pathname.endsWith("/api/chat")) return route.fulfill({ json: { chat: { id: "c1" } } });
    if (u.pathname.endsWith("/messages")) return route.fulfill({ json: {} });
    return route.fulfill({ json: { busy: false, changes: [{ id: 1, status: "pending", summary: `Add “${LONG}” to I5`, reason: `Listed at ${LINK}`, sources: [{ title: LONG, url: LINK }], ops: [{ op: "event.add", entity: "person", id: "I5", event: { type: "Occupation", value: LONG } }] }],
      messages: [{ role: "user", text: `${LINK} ${LONG}` }, { role: "assistant", parts: [{ type: "text", text: `**${LONG}** ${LINK}` }, { type: "tool", change: 1 }] }] } });
  });
  await page.goto(`${srv.url}/#/`);
  await page.waitForSelector("main h1", { timeout: 15000 });
}

test("no page is wider than a 320px screen, even with very long text", async () => {
  const wide = [];
  for (const page of pages)
  for (const p of ["/", "/people", `/person/${longId}`, "/person/I5", `/tree/${longId}`, "/branch/novak", "/stories", "/map", "/timeline",
    "/research", "/research/todo", "/research/queue", "/sources", "/source/S99", "/admin", "/admin/sites", "/admin/stories", "/admin/audit", "/about"]) {
    await page.evaluate((h) => { location.hash = h; }, "#" + p);
    await page.waitForTimeout(500);
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    if (w > 320) wide.push(`${page.engine}: ${p} is ${w}px wide`);
  }
  assert.deepEqual(wide, []);
  assert.deepEqual(errors, []);
});

test("the assistant opens as a full-screen sheet that fits, with 16px input", async () => {
  for (const page of pages) {
  await page.evaluate(() => { location.hash = "#/person/I5"; });
  await page.click(".chat-fab");
  await page.fill(".chat-form textarea", "hello");
  await page.keyboard.press("Enter");
  await page.locator(".chat-change").waitFor({ timeout: 5000 });
  const r = await page.evaluate(() => {
    const p = document.querySelector(".chat-panel").getBoundingClientRect(), log = document.querySelector(".chat-log");
    const head = document.querySelector(".chat-close").getBoundingClientRect(), hit = document.elementFromPoint(head.x + head.width / 2, head.y + head.height / 2);
    return { box: [p.left, p.top, p.width, p.height], vh: innerHeight, sideways: log.scrollWidth > log.clientWidth, font: getComputedStyle(document.querySelector(".chat-form textarea")).fontSize,
      closeOnTop: !!hit && !!hit.closest(".chat-close"), locked: getComputedStyle(document.documentElement).overflow === "hidden" };
  });
  assert.deepEqual(r.box, [0, 0, 320, r.vh], "fills the screen");
  assert.equal(r.sideways, false, "nothing in the conversation is wider than the panel");
  assert.equal(r.font, "16px", "no zoom-in on focus in iOS");
  assert.ok(r.closeOnTop, "the close button isn't covered by the site header");
  assert.ok(r.locked, "the page behind doesn't scroll");
  await page.click(".chat-close");
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).overflow), "visible", "scrolling comes back when it closes");
  }
  assert.deepEqual(errors, []);
});
