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
test("sources list and a source page", async () => {
  await visit("#/research", ["Research"]);
  await page.locator('a[href="#/sources"]').first().click();
  await page.waitForSelector("#src-table");
  await visit("#/sources", ["Sources", "Family recollection", "Civil Registration Death Index"]);
  assert.equal(await page.locator('#src-table tr[data-source="S3"] td').nth(3).innerText(), "3", "citation count");
  await page.fill("#src-search", "recollection");
  await page.waitForFunction(() => document.querySelectorAll("#src-table tbody tr").length === 1, null, { timeout: 5000 });
  await page.fill("#src-search", "");
  await page.locator('[data-sort="cites"]').click();
  await page.waitForFunction(() => document.querySelector("#src-table tbody tr")?.getAttribute("data-source") === "S3", null, { timeout: 5000 });
  await visit("#/source/S3", ["Family recollection", "Citations", "Merge into…"]);
  assert.ok(await page.locator('#src-citations a[href*="?fact="]').count() > 0, "citations link to the fact");
  await visit("#/source/S999", ["Source not found"]);
});
test("admin and audit history (owner)", async () => {
  await visit("#/admin", ["People and access", "Views"]);
  await visit("#/admin/sites", ["Research sites", "FamilySearch", "Subscription"]);
  await visit("#/admin/stories", ["Hidden stories", "Every story shows in every tree."]);
  await visit("#/admin/audit", ["Audit history"]);
  await page.locator(".audit-row").first().click();
  await page.locator(".audit-detail").first().waitFor({ timeout: 5000 });
  assert.deepEqual(errors, []);
});
test("about and not found", async () => {
  await visit("#/about", ["How this site works"]);
  await visit("#/no-such-page", ["Not found"]);
});

test("person attachments download and Markdown reports open in the viewer", async () => {
  await visit("#/person/I4", ["Attachments", "Add a report"]);
  await page.getByRole("button", { name: "Add an attachment" }).click();
  await page.getByLabel("File", { exact: true }).setInputFiles({
    name: "example.zip", mimeType: "application/zip", buffer: Buffer.from([0x50, 0x4b, 0, 0xff]),
  });
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  const archive = page.locator(".attachment-list li").filter({ hasText: "example.zip" });
  await archive.waitFor();
  const download = page.waitForEvent("download");
  await archive.getByRole("link", { name: "Download", exact: true }).click();
  assert.equal((await download).suggestedFilename(), "example.zip");

  await page.getByRole("button", { name: "Add a report" }).click();
  await page.getByLabel("Markdown file").setInputFiles({
    name: "example.md", mimeType: "text/markdown",
    buffer: Buffer.from("# Example heading\n\n**Evidence**\n\n<script>window.top.reportRan = true</script>"),
  });
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await page.getByRole("button", { name: "Read report" }).click();
  const report = page.frameLocator(".report-viewer");
  await report.getByRole("heading", { name: "Example heading" }).waitFor();
  assert.equal(await report.locator("strong").innerText(), "Evidence");
  assert.equal(await report.locator("script").count(), 0);
  assert.equal(await page.locator("#w-photos").getByText("example.md").count(), 0);
  const response = await page.request.post(`${srv.url}/mcp`, {
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_attachments", arguments: { person: "I4", type: "report" } } },
  });
  const result = (await response.json()).result;
  assert.ok(result);
  await page.goto(JSON.parse(result.content[0].text).attachments[0].page_url);
  await page.frameLocator(".report-viewer").getByRole("heading", { name: "Example heading" }).waitFor();
  assert.deepEqual(errors, []);
});

test("MCP cards render in a sandbox and open a record in the selected tree", async () => {
  const request = page.request;
  const mcp = async (method, params) => {
    const response = await request.post(`${srv.url}/mcp`, { data: { jsonrpc: "2.0", id: 1, method, params } });
    const payload = await response.json();
    assert.ok(payload.result, JSON.stringify(payload.error));
    return payload.result;
  };
  const create = await request.put(`${srv.url}/api/admin/trees/mcp-test`, {
    data: { name: "MCP browser example", definition: { branches: ["hartley"] } },
  });
  assert.ok(create.ok());
  const tools = await mcp("tools/list", {});
  const uri = tools.tools.find((t) => t.name === "get_person")._meta.ui.resourceUri;
  const resource = await mcp("resources/read", { uri });
  const result = await mcp("tools/call", { name: "get_person", arguments: { tree: "mcp-test", id: "I4" } });
  const preview = await browser.newPage();
  try {
    await preview.goto(srv.url);
    await preview.evaluate(({ html, result }) => {
      const frame = document.createElement("iframe");
      frame.title = "MCP card host";
      frame.sandbox.add("allow-scripts");
      addEventListener("message", ({ data, source }) => {
        if (source !== frame.contentWindow) return;
        if (data.method === "ui/initialize") source.postMessage({ jsonrpc: "2.0", id: data.id, result: { hostCapabilities: { openLinks: {} } } }, "*");
        if (data.method === "ui/notifications/initialized") source.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result }, "*");
        if (data.method === "ui/open-link") location.assign(data.params.url);
      });
      frame.srcdoc = html;
      document.body.append(frame);
    }, { html: resource.contents[0].text, result });
    const card = preview.frameLocator('iframe[title="MCP card host"]').locator("article").first();
    await card.getByRole("heading", { name: "George Hartley" }).waitFor();
    await card.getByRole("link", { name: "Open on family tree" }).click();
    await preview.waitForURL("**/?tree=mcp-test#/person/I4");
    await preview.getByRole("heading", { name: "George Hartley" }).waitFor();
    assert.equal(await preview.locator(".tree-switch").inputValue(), "mcp-test");
  } finally {
    await preview.close();
  }
});

test("a report linked to a source is readable from both pages", async () => {
  const response = await page.request.post(`${srv.url}/mcp`, { data: {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "add_report", arguments: { person: "I4", source: "S2", name: "example-source.md", markdown: "# Example transcription" } },
  } });
  assert.equal((await response.json()).result.isError, undefined);
  await page.goto(`${srv.url}/#/person/I4`);
  const report = page.locator(".attachment-list li").filter({ hasText: "example-source.md" });
  await report.getByRole("link", { name: /Source:/ }).click();
  await page.waitForURL("**/#/source/S2");
  await report.getByRole("button", { name: "Read report" }).click();
  await page.frameLocator(".report-viewer").getByRole("heading", { name: "Example transcription" }).waitFor();
});
