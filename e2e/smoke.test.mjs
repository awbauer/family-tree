// End-to-end smoke tests: every page of the site in a real browser, against the real Worker on the fictional example
// family (tools/dev_server.mjs). Each page must render its key content without a JavaScript error.
//
//   npm run test:e2e                 the built site (dist/site; run `npm run build:web` first)
//   E2E_SITE=site npm run test:e2e   another folder of static files
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join, dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startDevServer } from "../tools/dev_server.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = resolve(ROOT, process.env.E2E_SITE || "dist/site");
let srv, browser, page, errors = [];

before(async () => {
  srv = await startDevServer({ port: 0, site: SITE, quiet: true });
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|tile|leaflet|unpkg|fonts\.g/i.test(m.text())) errors.push(`console: ${m.text()}`); });
  await page.goto(`${srv.url}/#/`);
  await page.waitForSelector("#app h1, #app h2, main h1", { timeout: 15000 });
}, { timeout: 90_000 });
after(async () => { await browser?.close(); await srv?.close(); }, { timeout: 30_000 });

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
test("search: name variants in the header, everything on the search page", async () => {
  await visit("#/", ["Hartley"]);
  await page.fill("#search", "Hartlee");
  await page.waitForFunction(() => /Daniel James Hartley/.test(document.querySelector("#search-results").innerText), null, { timeout: 5000 });
  await page.press("#search", "ArrowDown");
  for (let i = 0; i < 12; i++) await page.press("#search", "ArrowDown"); // the last row searches every record
  await page.press("#search", "Enter");
  await page.waitForFunction(() => location.hash.startsWith("#/search?q=Hartlee"), null, { timeout: 5000 });
  await visit("#/search?q=portland", ["Daniel James Hartley", "Portland"]);
  assert.ok(await page.locator(".search-hits mark").count() >= 1);
  await visit("#/search?q=England", ["Eva comes to England"]);
  await page.getByRole("button", { name: /^Stories/ }).click();
  await page.waitForFunction(() => location.hash.includes("kind=story") && ![...document.querySelectorAll(".search-hits .badge")].some((b) => b.textContent === "Person"), null, { timeout: 5000 });
  assert.ok((await page.locator(".search-hits > li").count()) >= 1);
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
  await visit("#/tree/I1?view=chart", ["Ancestors"]);
  assert.ok(await page.locator("svg").count() > 0, "the chart draws");
});
test("tree views: family, fan, outline, and the choice is remembered", async () => {
  await visit("#/tree/I1?view=family&g=3", ["Family", "grandmother"]);
  assert.ok(await page.locator("#tg .g-node[data-id]").count() >= 7, "the family graph draws parents, grandparents and siblings");
  await visit("#/tree/I1?view=fan&g=5", ["Fan"]);
  assert.ok(await page.locator("#tg .fan-cell[data-id]").count() >= 10, "the ancestor fan draws");
  await visit("#/tree/I8?view=fan&mode=desc&g=4", ["Descendants"]);
  assert.ok(await page.locator("#tg .fan-cell[data-id]").count() >= 5, "the descendant sunburst draws");
  // an only child fills the whole ring: it must still draw (a ring, not a zero-width arc) and be clickable
  await visit("#/tree/I10?view=fan&mode=desc&g=3", ["Descendants"]);
  const only = await page.locator('#tg .fan-cell[data-id="I5"] path').boundingBox();
  assert.ok(only && only.width > 50 && only.height > 50, `an only child's ring is drawn (${JSON.stringify(only)})`);
  await visit("#/tree/I1?view=outline&g=5", ["Ahnentafel", "Grandparents", "Eva Novák"]);
  await visit("#/tree/I8?view=outline&mode=desc&g=4", ["d'Aboville", "1.2.1", "Daniel James Hartley"]);
  // pick a view with the toggle; a plain /tree link opens in it next time
  await visit("#/tree/I1", ["Ancestors"]);
  await page.locator('[data-view="fan"]').click();
  await page.waitForFunction(() => location.hash.includes("view=fan"), null, { timeout: 5000 });
  await visit("#/people", ["Eva Novák"]);
  await visit("#/tree/I5", ["Fan"]);
  await page.waitForSelector("#tg .fan-cell", { timeout: 5000 }).catch(() => assert.fail("the last view chosen is remembered"));
  await page.locator('[data-view="chart"]').click();
  await page.waitForFunction(() => location.hash.includes("view=chart"), null, { timeout: 5000 });
  assert.deepEqual(errors, []);
});
test("branch", async () => { await visit("#/branch/novak", ["Direct ancestors"]); });
test("stories and a story", async () => {
  await visit("#/stories", ["Stories", "Eva comes to England"]);
  await visit("#/story/eva-comes-to-england", ["Eva comes to England", "Sources"]);
  assert.ok(await page.locator('a[href="#/person/I5"]').count() > 0, "people in the story are linked");
});
test("map and timeline", async () => {
  await visit("#/map", ["Places", "Leeds, England"]);
  assert.match(page.url(), /#\/places/, "the old map address opens the Places page");
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

test("person page: photos and attachments on the left, resolved findings folded away, next steps behind a button", async () => {
  const call = async (name, args) => JSON.parse((await (await page.request.post(`${srv.url}/mcp`, { data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } })).json()).result.content[0].text);
  const f = (await call("list_findings", { person: "I6" })).findings[0];
  await call("update_finding", { id: f.id, status: "dismissed", note: "Example note.", version: f.version });
  await page.goto(`${srv.url}/#/person/I6`);
  await page.reload(); // a hash change alone keeps the tree the page already loaded
  await visit("#/person/I6", ["Photos and documents", "1 resolved finding"]);
  const box = async (sel) => (await page.locator(sel).boundingBox());
  assert.ok((await box("#w-photos")).x + (await box("#w-photos")).width <= (await box("#w-research")).x, "photos sit in the left column");
  assert.ok((await box("#w-attachments")).x < (await box("#w-research")).x, "attachments too");
  const resolved = page.locator(".resolved-findings");
  assert.equal(await resolved.evaluate((d) => d.open), false);
  assert.equal(await page.locator(`#finding-${f.id}`).isVisible(), false);
  await resolved.locator("summary").click();
  assert.equal(await page.locator(`#finding-${f.id}`).isVisible(), true);
  // a link straight to a resolved finding opens the list
  await page.goto(`${srv.url}/#/person/I6?section=finding-${f.id}`);
  await page.reload();
  await page.locator(`#finding-${f.id}`).waitFor({ state: "visible" });
  // the next-step form appears on demand
  assert.equal(await page.locator(".todo-new").count(), 0);
  await page.getByRole("button", { name: "Add a next step" }).click();
  await page.locator(".todo-new input[name='task']").fill("Look for an example record");
  await page.locator(".todo-new").getByRole("button", { name: "Add", exact: true }).click();
  await page.locator(".todo-list").getByText("Look for an example record").waitFor();
  assert.equal(await page.locator(".todo-new").count(), 0, "the form closes after adding");
  assert.deepEqual(errors, []);
});

test("a new page starts at the top, back and forward included", async () => {
  await visit("#/person/I4", ["Life events"]);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  assert.ok(await page.evaluate(() => window.scrollY) > 300);
  await page.locator(".facts .rel-list a").first().click();
  // the new page has drawn (clicking scrolled the link into view first, so the old position isn't the bottom)
  await page.waitForFunction(() => !location.hash.includes("/person/I4") && document.querySelector(".person-head h1")?.textContent !== "George Hartley");
  assert.equal(await page.evaluate(() => window.scrollY), 0);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.goBack();
  await page.waitForFunction(() => document.querySelector(".person-head h1")?.textContent === "George Hartley");
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.scrollY), 0);
});

test("an attachment that is an image shows in the photo gallery, not the attachment list", async () => {
  const photo = readFileSync(join(ROOT, "tests", "fixtures", "gps.jpg"));
  const res = await page.request.post(`${srv.url}/api/attachments?person=I10&type=attachment`, { data: photo, headers: { "X-Document-Name": "Example scan.jpg", "X-Document-Title": encodeURIComponent("Example scan") } });
  assert.equal(res.status(), 201, await res.text());
  await page.goto(`${srv.url}/#/person/I10`);
  await page.reload();
  const fig = page.locator("#w-photos figure").filter({ hasText: "Example scan" });
  await fig.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll("#w-photos img")].some((i) => i.alt === "Example scan" && i.naturalWidth > 0));
  assert.equal(await page.locator("#w-attachments").getByText("Example scan").count(), 0);
  await fig.click();
  const box = page.locator("dialog.lightbox");
  await box.getByRole("link", { name: "Download" }).waitFor();
  await box.getByRole("button", { name: "Link to more people" }).waitFor();
  assert.equal(await box.locator("[data-a=main]").count(), 0, "an attachment can't be the main photo");
  assert.deepEqual(errors, []);
});

test("places: the big map, a place page, putting a place on the map, and the person page's map", async () => {
  const edit = (ops) => page.request.post(`${srv.url}/api/edit`, { data: { reason: "places test", ops } });
  let r = await edit([{ op: "event.add", entity: "person", id: "I10", event: { type: "Residence", date: "1950", place: "3 Harbour Steps, Whitby, Yorkshire" } }]);
  assert.equal(r.status(), 200, await r.text());
  const doc = await page.request.post(`${srv.url}/api/attachments?person=I10&type=attachment`, { data: Buffer.from("%PDF-1.4\n%example\n"), headers: { "X-Document-Name": "Example letters.pdf", "X-Document-Title": encodeURIComponent("Example letters") } });
  assert.equal(doc.status(), 201, await doc.text());
  r = await edit([{ op: "media.update", person: "I10", file: (await doc.json()).file, set: { places: ["Leeds, England"] } }]);
  assert.equal(r.status(), 200, await r.text());

  await page.goto(`${srv.url}/#/places`);
  await page.reload();
  await page.locator(".places-list button").filter({ hasText: "Leeds, England" }).click();
  await page.getByRole("link", { name: "Open the place page" }).waitFor();
  assert.match(page.url(), /place=leeds/);
  await page.getByRole("link", { name: "Example letters" }).waitFor();
  await page.getByRole("link", { name: "Open the place page" }).click();
  await page.locator("h1").filter({ hasText: "Leeds, England" }).waitFor();
  for (const t of ["Who was here", "What happened here", "Photos and documents", "Example letters", "names this place"]) await page.getByText(t).first().waitFor();

  // a place text that isn't on the map yet: put it on with a point typed in
  await page.goto(`${srv.url}/#/places?tab=unplaced`);
  const row = page.locator(".unplaced li").filter({ hasText: "3 Harbour Steps, Whitby, Yorkshire" });
  await row.getByRole("button", { name: "Put on the map" }).click();
  const form = page.locator("form.place-form");
  await form.getByLabel("Name").fill("3 Harbour Steps, Whitby");
  await form.getByLabel("Latitude").fill("54.4858");
  await form.getByLabel("Longitude").fill("-0.6206");
  await form.getByRole("button", { name: "Save" }).click();
  await page.waitForEvent("load");
  await page.goto(`${srv.url}/#/person/I10`);
  const card = page.locator("#w-places");
  await card.getByRole("link", { name: "3 Harbour Steps, Whitby" }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll("#w-places .leaflet-marker-icon.pl-num").length > 0, null, { timeout: 10000 }).catch(() => {}); // Leaflet comes from a CDN
  await card.getByRole("link", { name: "3 Harbour Steps, Whitby" }).click();
  await page.locator("h1").filter({ hasText: "3 Harbour Steps, Whitby" }).waitFor();
  assert.ok(await page.getByText("3 Harbour Steps, Whitby, Yorkshire").count() > 0, "the place text it came from is listed");
  // the fact's place on the person page links to the place
  await page.goto(`${srv.url}/#/person/I10`);
  await page.locator(".t-place a").filter({ hasText: "3 Harbour Steps" }).waitFor();
  assert.deepEqual(errors, []);
});

test("places as a hierarchy: browse by place, breadcrumbs, and a place added inside another", async () => {
  const r = await page.request.post(`${srv.url}/api/edit`, { data: { reason: "hierarchy test", ops: [
    { op: "place.save", key: "england", name: "England", type: "country", lat: 52.6, lng: -1.5 },
    { op: "place.save", key: "leeds", name: "Leeds", type: "city", parent: "england", names: [{ name: "Loidis", to: 1200 }] },
  ] } });
  assert.equal(r.status(), 200, await r.text());
  await page.goto(`${srv.url}/#/places?tab=tree`);
  await page.reload();
  const row = (name) => page.locator(".pt-row").filter({ has: page.locator(".pl-name", { hasText: new RegExp(`^${name}$`) }) });
  await row("England").locator(".pt-toggle").click();
  await row("Leeds").locator(".pt-name").click();
  await page.getByRole("link", { name: "Open the place page" }).click();
  await page.locator("h1").filter({ hasText: "Leeds" }).waitFor();
  await page.locator(".crumbs").getByRole("link", { name: "England" }).waitFor();
  await page.getByText("Loidis").waitFor();

  await page.getByRole("button", { name: "Add a place inside it" }).click();
  const form = page.locator("form.place-form");
  await form.getByLabel("Name", { exact: true }).fill("Example Street");
  await form.getByLabel("Kind of place").selectOption("street");
  await form.getByText("Full name: Example Street, Leeds, England").waitFor();
  await form.getByRole("button", { name: "Save" }).click();
  await page.waitForEvent("load");
  await page.locator("h1").filter({ hasText: "Example Street" }).waitFor();
  await page.getByText("No point of its own: shown at Leeds").waitFor();
  await page.locator(".crumbs").getByRole("link", { name: "Leeds" }).click();
  await page.locator("h1").filter({ hasText: "Leeds" }).waitFor();
  await page.getByRole("link", { name: "Example Street" }).waitFor();
  assert.deepEqual(errors, []);
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

test("one attachment can be uploaded to several people and linked to more later", async () => {
  await visit("#/person/I4", ["Attachments", "Add a report"]);
  await page.getByRole("button", { name: "Add an attachment" }).click();
  await page.getByLabel("File", { exact: true }).setInputFiles({ name: "shared.txt", mimeType: "text/plain", buffer: Buffer.from("shared") });
  const also = page.locator("#w-attachments input[name='also-attachment']");
  const option = await page.locator("#also-attachment-people option").evaluateAll((os) => os.map((o) => o.value).find((v) => /\(I3\)$/.test(v)));
  await also.fill(option);
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  const item = page.locator(".attachment-list li").filter({ hasText: "shared.txt" });
  await item.waitFor();
  await item.getByText("Also on:").waitFor();
  await item.getByRole("button", { name: "Link to more people" }).click();
  const more = await page.locator("datalist[id^='link-'] option").evaluateAll((os) => os.map((o) => o.value).find((v) => /\(I2\)$/.test(v)));
  await item.locator("input[name^='link-']").fill(more);
  await item.getByRole("button", { name: "Link", exact: true }).click();
  for (const other of ["I3", "I2"]) {
    await visit(`#/person/${other}`, ["Attachments"]);
    await page.locator(".attachment-list li").filter({ hasText: "shared.txt" }).getByText("Also on:").waitFor();
  }
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

test("MCP cards cope with hosts that don't follow the happy path", async () => {
  const rpcCall = async (method, params) => (await (await page.request.post(`${srv.url}/mcp`, { data: { jsonrpc: "2.0", id: 1, method, params } })).json()).result;
  const tools = await rpcCall("tools/list", {});
  const html = (await rpcCall("resources/read", { uri: tools.tools.find((t) => t.name === "get_person")._meta.ui.resourceUri })).contents[0].text;
  const result = await rpcCall("tools/call", { name: "get_person", arguments: { id: "I4" } });
  const preview = await browser.newPage();
  try {
    await preview.goto(srv.url);
    await preview.evaluate(({ html, result }) => {
      // three hosts: one answers ui/initialize with an error, one sends the result before the handshake, one never sends it
      for (const kind of ["error", "early", "silent"]) {
        const frame = document.createElement("iframe");
        frame.title = `host-${kind}`;
        frame.sandbox.add("allow-scripts");
        addEventListener("message", ({ data, source }) => {
          if (source !== frame.contentWindow) return;
          if (data.method === "ui/open-link") return location.assign(data.params.url);
          if (data.method !== "ui/initialize") return;
          if (kind === "error") {
            source.postMessage({ jsonrpc: "2.0", id: data.id, error: { code: -32602, message: "Unsupported protocol version" } }, "*");
            source.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result }, "*");
          } else if (kind === "early") {
            source.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result }, "*");
            source.postMessage({ jsonrpc: "2.0", id: data.id, result: { hostCapabilities: { openLinks: {} } } }, "*");
          } else source.postMessage({ jsonrpc: "2.0", id: data.id, result: {} }, "*");
        });
        frame.srcdoc = html;
        document.body.append(frame);
      }
    }, { html, result });
    for (const kind of ["error", "early"]) {
      await preview.frameLocator(`iframe[title="host-${kind}"]`).getByRole("heading", { name: "George Hartley" }).first().waitFor({ timeout: 5000 });
    }
    const silent = preview.frameLocator('iframe[title="host-silent"]');
    await silent.getByText("Loading records…").waitFor();
    await silent.getByText("didn't load in this app").waitFor({ timeout: 12_000 });
    // the early card was drawn before the host said it opens links; its link still goes through the host
    await preview.frameLocator('iframe[title="host-early"]').getByRole("link", { name: "Open on family tree" }).first().click();
    await preview.waitForURL("**#/person/I4", { timeout: 5000 });
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
