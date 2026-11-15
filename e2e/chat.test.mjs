// The page assistant panel in a real browser. The agents aren't part of the dev server, so the chat endpoints
// are answered here (and /api/me says the agents are on); the edit preview goes to the real Worker.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startDevServer } from "../tools/dev_server.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = resolve(ROOT, process.env.E2E_SITE || "dist/site");
let srv, browser, page, errors = [];
const calls = [];
let reply = { busy: false, messages: [], changes: [] };

before(async () => {
  srv = await startDevServer({ port: 8798, site: SITE, quiet: true });
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|fonts\.g/i.test(m.text())) errors.push(`console: ${m.text()}`); });
  await page.route(/\/api\/me(\?|$)/, async (route) => {
    const r = await route.fetch();
    route.fulfill({ response: r, json: { ...(await r.json()), ai: true } });
  });
  await page.route(/\/api\/chat/, async (route) => {
    const req = route.request(), url = new URL(req.url());
    calls.push(`${req.method()} ${url.pathname}`);
    if (req.method() === "POST" && url.pathname.endsWith("/api/chat")) return route.fulfill({ json: { chat: { id: "c1" } } });
    if (req.method() === "POST" && url.pathname.endsWith("/messages")) {
      reply = {
        busy: false, changes: [{ id: 7, status: "pending", summary: "Add an occupation to I5", reason: "You said so", ops: [{ op: "event.add", entity: "person", id: "I5", event: { type: "Occupation", value: "Example work" } }] }],
        messages: [{ role: "user", text: JSON.parse(req.postData()).text }, { role: "assistant", parts: [{ type: "text", text: "Here is **I5**:\n\n- one\n- two" }, { type: "tool", tool: "get_person", state: "done", about: "I5" }, { type: "tool", change: 7 }] }],
      };
      return route.fulfill({ json: {} });
    }
    if (req.method() === "POST" && url.pathname.endsWith("/dismiss")) { reply.changes[0].status = "dismissed"; return route.fulfill({ json: {} }); }
    if (req.method() === "GET" && url.pathname.endsWith("/api/chat/c1")) return route.fulfill({ json: reply });
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });
  await page.goto(`${srv.url}/#/person/I5`);
  await page.waitForSelector(".chat-fab", { timeout: 15000 });
});
after(async () => { await browser?.close(); await srv?.close(); });

test("ask, see the drafted change with its preview, dismiss it", async () => {
  await page.click(".chat-fab");
  assert.match(await page.locator(".chat-where").innerText(), /on Eva Novák/);
  await page.fill(".chat-form textarea", "She worked; add it");
  await page.keyboard.press("Enter");
  await page.locator(".chat-msg.bot b").waitFor({ timeout: 5000 });
  assert.equal(await page.locator(".chat-msg.bot li").count(), 2, "lists render");
  assert.ok(await page.locator('.chat-msg.bot a[href="#/person/I5"]').count(), "person ids link");
  await page.locator(".chat-change .chat-diff .diff").waitFor({ timeout: 5000 });
  assert.match(await page.locator(".chat-diff").innerText(), /Occupation/);
  await page.click(".chat-change button:has-text('Dismiss')");
  await page.locator(".chat-change.st-dismissed").waitFor({ timeout: 5000 });
  assert.equal(await page.locator(".chat-form textarea").inputValue(), "", "the draft clears once sent");
  assert.ok(calls.includes("POST /api/chat/c1/messages") && calls.includes("POST /api/chat/changes/7/dismiss"));
  await page.click(".chat-close");
  assert.ok(await page.locator(".chat-fab").isVisible());
  assert.deepEqual(errors, []);
});
