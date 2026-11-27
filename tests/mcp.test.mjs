// The MCP server (worker/mcp.js) against the fictional example family: the protocol, who sees which tools, scoping
// through grants and views, relationship questions with known answers, writes through the site's own rules, the
// audit trail, and snapshots of tool output (UPDATE_SNAPSHOTS=1 npm test rewrites them).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEnv, client, migrate } from "./helpers/fake-env.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SNAP = join(ROOT, "tests", "snapshots");
const OWNER = "owner@example.test", MEMBER = "cousin@example.test", NAMES = "aunt@example.test", EDITOR = "editor@example.test", STRANGER = "nobody@example.test";
let env, call, worker;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ft-mcp-"));
  execFileSync("python3", ["tools/build.py", "--data", "example", "--out", dir, "--raw-out", join(dir, "raw.json")], { cwd: ROOT });
  const research = JSON.parse(readFileSync(join(ROOT, "example/research.json"), "utf8"));
  research.trees = [{ id: "all", name: "Everyone", definition: { branches: ["*"] } },
    { id: "one", name: "One branch", definition: { branches: [research.branches[0].key] } }];
  writeFileSync(join(dir, "research.json"), JSON.stringify(research));
  execFileSync("python3", ["tools/seed_app.py", "--raw", join(dir, "raw.json"), "--bundle", join(dir, "family.json"),
    "--research", join(dir, "research.json"), "--out", join(dir, "seed.sql"), "--owner", OWNER, "--cutover"], { cwd: ROOT });
  env = makeEnv();
  migrate(env.DB, ROOT);
  env.DB.execFile(join(dir, "seed.sql"));
  worker = (await import("../worker/index.js")).default;
  call = client(worker, env);
  await call("PUT", "/api/admin/views/names", { body: { name: "Names only", filter: { living: "names-only" } } });
  await call("PUT", "/api/admin/grants", { body: { principal: MEMBER, tree_id: "one", role: "member" } });
  await call("PUT", "/api/admin/grants", { body: { principal: NAMES, tree_id: "all", role: "member", view_id: "names" } });
  await call("PUT", "/api/admin/grants", { body: { principal: EDITOR, tree_id: "all", role: "editor" } });
});

let rid = 0;
async function rpc(method, params, { as = OWNER, headers = {}, raw } = {}) {
  const res = await worker.fetch(new Request("https://tree.example.test/mcp", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Dev-Principal": as, ...headers },
    body: raw !== undefined ? raw : JSON.stringify({ jsonrpc: "2.0", id: ++rid, method, params }),
  }), env, { waitUntil() {} });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
/** Call a tool; returns {error, data} with data parsed from the text content. */
async function tool(name, args = {}, as = OWNER) {
  const r = await rpc("tools/call", { name, arguments: args }, { as });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const res = r.body.result;
  const c = res.content[0];
  let data = c.text;
  if (c.type === "text") try { data = JSON.parse(c.text); } catch { /* plain text */ }
  return { error: !!res.isError, data, content: res.content, cards: res.structuredContent?.cards || [] };
}
const ids = (list) => list.map((p) => p.id);

function snapshot(name, value) {
  const file = join(SNAP, `mcp-${name}.json`);
  const text = JSON.stringify(value, null, 2) + "\n";
  if (process.env.UPDATE_SNAPSHOTS || !existsSync(file)) { mkdirSync(SNAP, { recursive: true }); writeFileSync(file, text); return; }
  assert.equal(text, readFileSync(file, "utf8"), `snapshot ${name} changed (UPDATE_SNAPSHOTS=1 npm test to accept)`);
}

// ---------------------------------------------------------------- protocol
test("initialize negotiates the protocol and sends instructions", async () => {
  const r = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.result.protocolVersion, "2025-06-18");
  assert.ok(r.body.result.capabilities.tools);
  assert.match(r.body.result.instructions, /Never invent records/);
  const odd = await rpc("initialize", { protocolVersion: "1999-01-01" });
  assert.equal(odd.body.result.protocolVersion, "2025-11-25");
});

test("notifications get 202, GET is refused, bad JSON and unknown methods are errors", async () => {
  const n = await rpc(null, null, { raw: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert.equal(n.status, 202);
  const g = await worker.fetch(new Request("https://tree.example.test/mcp", { headers: { "X-Dev-Principal": OWNER } }), env, {});
  assert.equal(g.status, 405);
  assert.equal((await rpc(null, null, { raw: "{nope" })).body.error.code, -32700);
  assert.equal((await rpc("no/such")).body.error.code, -32601);
  const batch = await rpc(null, null, { raw: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "ping" }]) });
  assert.equal(batch.body.length, 2);
});

test("unauthenticated requests and foreign origins are refused", async () => {
  const strict = makeEnv({ ALLOW_UNAUTHENTICATED: "false", ACCESS_TEAM_DOMAIN: "team.example.test", ACCESS_AUD: "aud" });
  const res = await worker.fetch(new Request("https://tree.example.test/mcp", { method: "POST", body: "{}" }), strict, {});
  assert.equal(res.status, 401);
  assert.match(res.headers.get("WWW-Authenticate"), /Bearer/);
  const evil = await rpc("ping", {}, { headers: { Origin: "https://evil.example.test" } });
  assert.equal(evil.status, 403);
  assert.equal((await rpc("ping", {}, { headers: { Origin: "https://tree.example.test" } })).status, 200);
});

test("tools are listed by role, with annotations", async () => {
  const names = async (as) => (await rpc("tools/list", {}, { as })).body.result.tools.map((t) => t.name);
  const owner = await names(OWNER), editor = await names(EDITOR), member = await names(MEMBER);
  assert.ok(owner.includes("admin_grant") && owner.includes("edit_tree") && owner.includes("search_people"));
  assert.ok(editor.includes("edit_tree") && editor.includes("review_suggestion") && !editor.includes("admin_grant"));
  assert.ok(member.includes("suggest_edit") && member.includes("get_person") && !member.includes("edit_tree") && !member.includes("admin_overview"));
  const tools = (await rpc("tools/list", {}, { as: OWNER })).body.result.tools;
  const t = (n) => tools.find((x) => x.name === n);
  assert.equal(t("get_person").annotations.readOnlyHint, true);
  assert.equal(t("edit_tree").annotations.destructiveHint, true);
  assert.deepEqual(t("get_person").inputSchema.required, ["id"]);
  assert.ok(t("get_person").inputSchema.properties.tree);
  // nothing that starts the AI agents
  for (const n of owner) assert.doesNotMatch(n, /^(start|run)_|chat|refresh/);
});

test("a tool the caller's role doesn't have is refused even if called directly", async () => {
  const r = await tool("edit_tree", { ops: [{ op: "person.update", id: "I4", set: { notes: "x" } }], reason: "test" }, MEMBER);
  assert.equal(r.error, true);
  const a = await tool("admin_overview", {}, EDITOR);
  assert.equal(a.error, true);
});

test("arguments are checked against the schema", async () => {
  assert.match((await tool("get_person", {})).data, /id is required/);
  assert.match((await tool("get_person", { id: "I4", bogus: 1 })).data, /unknown field/);
  assert.match((await tool("get_ancestors", { id: "I1", generations: "four" })).data, /generations must be integer/);
  assert.match((await tool("list_findings", { status: "maybe" })).data, /must be one of/);
});

// ---------------------------------------------------------------- reading, and relationship questions
test("whoami and the tree overview", async () => {
  const me = await tool("whoami", {}, MEMBER);
  assert.deepEqual(me.data.trees.map((t) => t.id), ["one"]);
  const o = await tool("tree_overview", { tree: "all" });
  assert.equal(o.data.counts.people, 18);
  assert.equal(o.data.home_person.id, "I1");
  snapshot("tree-overview", o.data);
});

test("relationship questions with known answers", async () => {
  const rel = async (from, to) => (await tool("relationship_between", { from, to })).data;
  assert.match((await rel("I1", "I4")).label, /grandfather/i);
  assert.match((await rel("I1", "I18")).label, /great-aunt/i);
  assert.match((await rel("I16", "I1")).label, /brother/i);
  const r = await rel("I1", "I6");
  assert.deepEqual(r.chain.map((x) => x.id), ["I1", "I3", "I6"]);
  assert.match(r.summary, /mother/);
  // cousins of the home person's parents share the right ancestors
  const c = await rel("I4", "I17");
  assert.ok(c.common_ancestors.some((x) => x.id === "I8"));
  // `from` defaults to the tree's home person
  assert.match((await tool("relationship_between", { to: "I8" })).data.label, /great-grandfather/i);
});

test("pedigree with Ahnentafel numbers, and descendants", async () => {
  const a = (await tool("get_ancestors", { id: "I1", generations: 3 })).data;
  const by = Object.fromEntries(a.ancestors.map((x) => [x.ahnentafel, x.id]));
  assert.deepEqual([by[2], by[3], by[4], by[5], by[6], by[7], by[8], by[9]], ["I2", "I3", "I4", "I5", "I6", "I7", "I8", "I9"]);
  assert.ok(a.unknown_ancestor_numbers.length > 0);
  snapshot("ancestors-I1", a);
  const d = (await tool("get_descendants", { id: "I8", generations: 3 })).data;
  assert.ok(ids(d.descendants).includes("I4") && ids(d.descendants).includes("I17") && ids(d.descendants).includes("I1"));
  assert.equal(d.descendants.find((x) => x.id === "I4").generation, 1);
});

test("search, person, family, timeline, events, surnames, places, sources", async () => {
  const s = (await tool("search_people", { surname: "Hartley", born_to: 1935 })).data;
  assert.deepEqual(ids(s.people).sort(), ["I17", "I4", "I8"].sort());
  assert.equal((await tool("search_people", { query: "novak" })).data.total, 2); // accents ignored
  const p = (await tool("get_person", { id: "I4" })).data;
  assert.equal(p.name, "George Hartley");
  assert.ok(p.events.every((e) => e.fid));
  assert.ok(p.findings.length >= 1);
  snapshot("person-I4", p);
  const f = (await tool("get_family", { id: "I1" })).data;
  assert.deepEqual(ids(f.parents).sort(), ["I2", "I3"]);
  assert.deepEqual(ids(f.siblings), ["I16"]);
  assert.deepEqual(ids((await tool("get_family", { id: "F1" })).data.children).sort(), ["I1", "I16"]);
  const tl = (await tool("get_timeline", { id: "I4" })).data.events;
  assert.equal(tl[0].type, "Birth");
  assert.ok(tl.some((e) => e.whose === "child" && e.person.id === "I2"));
  const occ = (await tool("search_events", { type: "occupation" })).data;
  assert.ok(occ.events.some((e) => e.person && e.person.id === "I4"));
  assert.ok((await tool("list_surnames")).data.surnames.some((x) => x.surname === "Hartley" && x.people >= 5));
  assert.ok((await tool("list_places", { query: "leeds" })).data.places.length >= 1);
  const src = (await tool("get_source", { id: "S2" })).data;
  assert.ok(src.cited_by.some((x) => x.person && x.person.id === "I4"));
  assert.ok((await tool("list_stories")).data.stories.length >= 1);
  assert.ok((await tool("get_story", { slug: "eva-comes-to-england" })).data.body);
  assert.ok((await tool("list_data_issues")).data.total >= 1);
});

test("search_text finds facts, stories and name variants, and links each result", async () => {
  const r = await tool("search_text", { query: "portland" });
  assert.ok(r.data.results.some((h) => h.kind === "person" && h.id === "I2" && h.matched.some((m) => m.in === "fact")));
  const st = (await tool("search_text", { query: "England", kinds: ["story"] })).data;
  assert.ok(st.results.length && st.results.every((h) => h.kind === "story" && h.page_url.includes("#/story/")));
  const alike = (await tool("search_text", { query: "Hartlee", kinds: ["person"] })).data.results;
  assert.ok(alike.some((h) => h.id === "I2" && h.matched[0].how));
  assert.equal((await tool("search_text", { query: "Hartlee", kinds: ["person"], variants: false })).data.total, 0);
  assert.ok((await tool("search_people", { query: "Hartlee", sounds_like: true })).data.people.some((p) => p.id === "I2"));
  assert.equal((await tool("search_people", { query: "Hartlee" })).data.total, 0);
});

// ---------------------------------------------------------------- scope: grants and views
test("a member sees only their tree", async () => {
  const s = (await tool("search_people", {}, MEMBER)).data;
  assert.ok(s.total > 0 && s.people.every((p) => ["I4", "I8", "I9", "I15", "I17"].includes(p.id)));
  const r = await tool("get_person", { id: "I1" }, MEMBER);
  assert.equal(r.error, true);
  assert.equal((await tool("tree_overview", { tree: "all" }, MEMBER)).error, true);
});

test("a names-only view gives living people as names only, through every tool", async () => {
  const p = (await tool("get_person", { id: "I1" }, NAMES)).data;
  assert.equal(p.private, true);
  assert.equal(p.events, undefined);
  const s = (await tool("search_people", { query: "Hartley" }, NAMES)).data;
  assert.deepEqual(s.people.find((x) => x.id === "I2"), { id: "I2", name: "Daniel James Hartley", private: true, page_url: "https://tree.example.test/?tree=all#/person/I2" });
  assert.ok(!(await tool("search_events", {}, NAMES)).data.events.some((e) => e.person && ["I1", "I2", "I3", "I16"].includes(e.person.id)));
  assert.equal((await tool("get_timeline", { id: "I2" }, NAMES)).data.events.length, 0);
  // text search finds them by name only, never by a fact their view hides
  assert.ok(!(await tool("search_text", { query: "portland" }, NAMES)).data.results.some((h) => h.id === "I2"));
  assert.deepEqual((await tool("search_text", { query: "Daniel Hartley" }, NAMES)).data.results.find((h) => h.id === "I2")?.private, true);
  // the owner (full view) sees them in full, living or not
  assert.ok((await tool("get_person", { id: "I1" })).data.birth);
});

// ---------------------------------------------------------------- writes through the site's rules
test("members suggest; editors preview, review, edit and undo", async () => {
  const ops = [{ op: "event.add", entity: "person", id: "I17", event: { type: "Occupation", value: "Example trade", date: "1950" } }];
  const prev = (await tool("preview_edit", { ops }, MEMBER)).data;
  assert.equal(prev.touched[0].id, "I17");
  const sug = await tool("suggest_edit", { ops, reason: "Example directory entry", sources: [{ title: "Example directory, 1950", note: "p. 1" }] }, MEMBER);
  assert.equal(sug.error, false, sug.data);
  const id = sug.data.proposal.id;
  assert.equal((await tool("list_suggestions", {}, MEMBER)).data.proposals[0].id, id);
  const ok = await tool("review_suggestion", { id, decision: "approve", tree: "one" }, OWNER);
  assert.equal(ok.data.status, "approved");
  assert.ok((await tool("get_person", { id: "I17" })).data.events.some((e) => e.value === "Example trade"));

  const edit = await tool("edit_tree", { tree: "all", ops: [{ op: "person.update", id: "I18", set: { notes: ["An example note."] } }], reason: "test edit" }, EDITOR);
  assert.equal(edit.error, false, edit.data);
  const hist = (await tool("get_history", { id: "I18" }, EDITOR)).data.history;
  assert.equal(hist[0].batch, edit.data.batch);
  const undo = await tool("revert_change", { batch: edit.data.batch, reason: "test" }, EDITOR);
  assert.equal(undo.data.reverted, edit.data.batch);
});

test("research suggestions, to-dos, findings and comments", async () => {
  const td = await tool("create_todo", { person: "I17", task: "Find an example record", priority: "low" }, MEMBER);
  assert.equal(td.error, false, td.data);
  const tid = td.data.todo.id;
  assert.equal((await tool("claim_todo", { id: tid }, MEMBER)).data.todo.status, "in_progress");
  const batch = { log: [{ person: "I17", searched: "Example index, 1925–1935", result: "nil" }] };
  const sr = await tool("suggest_research", { batch, rationale: "nothing found", todo_id: tid }, MEMBER);
  assert.equal(sr.error, false, sr.data);
  assert.equal((await tool("list_todos", { person: "I17" }, MEMBER)).data.todos.find((t) => t.id === tid).status, "needs_review");
  assert.ok((await tool("get_todo_history", { id: tid }, MEMBER)).data.events.length >= 2);
  // members can't close findings; editors can
  const f = (await tool("list_findings", { person: "I4" })).data.findings[0];
  assert.equal((await tool("update_finding", { id: f.id, status: "resolved", note: "x" }, MEMBER)).error, true);
  assert.equal((await tool("update_finding", { id: f.id, status: "dismissed", note: "keep as is" }, EDITOR)).data.ok, true);
  assert.equal((await tool("update_finding", { id: f.id, status: "open" }, EDITOR)).data.ok, true);
  const cm = await tool("add_comment", { id: "I17", body: "Is this the right parish?" }, MEMBER);
  assert.equal(cm.error, false, cm.data);
  assert.equal((await tool("list_comments", { id: "I17" }, MEMBER)).data.comments.length, 1);
  assert.equal((await tool("resolve_comment", { id: cm.data.comment.id }, MEMBER)).data.ok, true);
});

test("upload a photo, attach it, read it back as an image", async () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const up = await tool("upload_media", { name: "example.png", content_type: "image/png", data_base64: png }, EDITOR);
  assert.equal(up.error, false, up.data);
  const key = up.data.key;
  // not attached to anyone yet: not readable
  assert.equal((await tool("get_media", { file: key }, EDITOR)).error, true);
  await tool("edit_tree", { ops: [{ op: "media.attach", person: "I4", file: key, caption: "Example photo" }], reason: "test" }, EDITOR);
  const m = await tool("get_media", { file: key }, EDITOR);
  assert.equal(m.content[0].type, "image");
  assert.equal(m.content[0].mimeType, "image/png");
  assert.equal(m.content[0].data, png);
  assert.ok((await tool("get_person", { id: "I4" })).data.media.some((x) => x.file === key));
  // a member of the other branch can't read it
  assert.equal((await tool("get_media", { file: key }, NAMES)).error, false); // I4 is fully visible to them
});

test("photos uploaded over MCP lose their location and camera data", async () => {
  const photo = readFileSync(join(ROOT, "tests", "fixtures", "gps.jpg"));
  assert.ok(photo.includes("ExampleCam"));
  const up = await tool("upload_media", { name: "phone.jpg", content_type: "image/jpeg", data_base64: photo.toString("base64") }, EDITOR);
  assert.equal(up.error, false, up.data);
  const stored = Buffer.from(await (await env.MEDIA.get(up.data.key)).arrayBuffer());
  assert.ok(!stored.includes("ExampleCam"));
  assert.ok(stored.length < photo.length);
  const doc = await tool("add_attachment", { person: "I4", name: "scan.jpg", data_base64: photo.toString("base64") }, EDITOR);
  assert.equal(doc.error, false, doc.data);
  assert.ok(!Buffer.from(await (await env.MEDIA.get(doc.data.file)).arrayBuffer()).includes("ExampleCam"));
});

test("photos too large for AI clients: scaled down with the Images binding, or a link without it", async () => {
  const be32 = (n) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  const big = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be32(4032), ...be32(3024), 8, 2, 0, 0, 0]).toString("base64");
  const up = await tool("upload_media", { name: "phone-photo.png", content_type: "image/png", data_base64: big }, EDITOR);
  assert.equal(up.error, false, up.data);
  await tool("edit_tree", { ops: [{ op: "media.attach", person: "I4", file: up.data.key, caption: "Big photo" }], reason: "test" }, EDITOR);
  // no binding: a link, never an image the client would refuse
  const plain = await tool("get_media", { file: up.data.key }, EDITOR);
  assert.equal(plain.error, false);
  assert.ok(!plain.content.some((c) => c.type === "image"));
  assert.match(plain.data.download_url, /\/media\//);
  assert.match(plain.data.note, /too large/);
  // with the binding: a smaller JPEG, and a note pointing at the full-size file
  env.IMAGES = { input: () => ({ transform() { return this; }, async output() { return { response: () => new Response(new Uint8Array([0xff, 0xd8, 1, 2])) }; } }) };
  try {
    const m = await tool("get_media", { file: up.data.key }, EDITOR);
    assert.equal(m.content[0].type, "image");
    assert.equal(m.content[0].mimeType, "image/jpeg");
    assert.match(JSON.parse(m.content[1].text).note, /4032×3024/);
  } finally { delete env.IMAGES; }
});

test("MCP_CARDS=off: no inline cards advertised", async () => {
  const on = (await rpc("tools/list", {})).body.result.tools;
  assert.ok(on.some((t) => t._meta?.ui?.resourceUri));
  env.MCP_CARDS = "off";
  try {
    const off = (await rpc("tools/list", {})).body.result.tools;
    assert.ok(!off.some((t) => t._meta), "no tool points at the card view");
    assert.deepEqual((await rpc("resources/list", {})).body.result.resources, []);
  } finally { delete env.MCP_CARDS; }
});

test("owner tools: sharing settings and the audit trail of tool calls", async () => {
  const a = (await tool("admin_overview")).data;
  assert.ok(a.grants.some((g) => g.principal === MEMBER));
  const g = await tool("admin_grant", { principal: STRANGER, tree_id: "one", role: "member" });
  assert.equal(g.data.ok, true);
  assert.deepEqual((await tool("whoami", {}, STRANGER)).data.trees.map((t) => t.id), ["one"]);
  assert.equal((await tool("admin_revoke_grant", { principal: STRANGER, tree_id: "one" })).data.ok, true);
  assert.equal((await tool("search_people", {}, STRANGER)).error, true);
  // every call is logged with the member and the tool, never its arguments
  const rows = (await env.DB.prepare("SELECT * FROM changes WHERE entity_type = 'mcp' AND entity_id = 'search_people' AND actor = ?").bind(MEMBER).all()).results;
  assert.ok(rows.length >= 1);
  for (const r of rows) assert.doesNotMatch(String(r.after) + String(r.reason), /Hartley|query/);
  const audit = (await tool("audit_log", { type: "mcp", limit: 5 })).data;
  assert.ok(audit.batches.length >= 1);
});

test("an attached photo comes back as an image a client can show, not an opaque file", async () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const up = await tool("add_attachment", { person: "I1", name: "Scan of a letter.png", data_base64: png });
  assert.equal(up.error, false, up.data);
  const get = await tool("get_attachment", { file: up.data.file });
  assert.equal(get.content[0].type, "image");
  assert.equal(get.content[0].mimeType, "image/png");
  assert.equal(get.content[0].data, png);
});

test("exports respect the caller's view", async () => {
  const ged = (await tool("export_tree", { tree: "all" }, EDITOR)).data;
  assert.match(ged, /^0 HEAD/);
  assert.equal((await tool("export_tree", {}, MEMBER)).error, true);
});

test("person attachments keep the original bytes and obey tree and media scope", async () => {
  const file = Buffer.from([0x50, 0x4b, 0xff, 0x00]);
  const up = await tool("add_attachment", { person: "I1", name: "Example archive.zip", data_base64: file.toString("base64") });
  assert.equal(up.error, false, up.data);
  assert.equal(up.data.type, "attachment");
  const key = up.data.file;
  const get = await tool("get_attachment", { file: key });
  assert.equal(get.content[0].resource.blob, file.toString("base64"));
  const list = await tool("list_attachments", { person: "I1" });
  assert.ok(list.data.attachments.some((m) => m.file === key && m.caption === "Example archive.zip"));
  assert.equal((await tool("get_attachment", { file: key }, NAMES)).error, true);
  assert.equal((await tool("get_attachment", { file: key }, MEMBER)).error, true);
  const res = await worker.fetch(new Request(`https://tree.example.test/media/${key}?tree=all`, {
    headers: { "X-Dev-Principal": OWNER },
  }), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "application/octet-stream");
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  assert.match(res.headers.get("Content-Disposition"), /^attachment;.*Example%20archive.zip$/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), file);
  assert.equal((await call("GET", `/media/${key}?tree=all&preview_view=names`)).status, 404);
});

test("member reports are private until approved and cannot become a portrait", async () => {
  const markdown = "# Example report\n\n**Sample** text.";
  const args = { person: "I17", name: "Example.md", markdown };
  assert.equal((await tool("add_report", { ...args, name: "Example.pdf" }, MEMBER)).error, true);
  const up = await tool("add_report", args, MEMBER);
  assert.equal(up.error, false, up.data);
  const { file, proposal } = up.data;
  assert.equal((await tool("get_report", { file }, MEMBER)).error, true);
  assert.equal((await call("GET", `/media/${file}?tree=one&proposal=${proposal}`)).data, markdown);
  assert.equal((await call("GET", `/media/${file}?tree=one&proposal=${proposal + 1}`)).status, 404);
  const approved = await tool("review_suggestion", { id: proposal, decision: "approve", tree: "one" });
  assert.equal(approved.error, false, approved.data);
  assert.equal((await tool("get_report", { file }, MEMBER)).data.markdown, markdown);
  const person = (await tool("get_person", { id: "I17" }, MEMBER)).data;
  assert.equal(person.attachments.find((m) => m.file === file).type, "report");
  assert.ok(!person.media?.some((m) => m.file === file));
  const portrait = await tool("edit_tree", { ops: [{ op: "media.set_primary", person: "I17", file }], reason: "test" });
  assert.equal(portrait.error, true);
  const remove = await tool("edit_tree", { ops: [{ op: "media.detach", person: "I17", file }], reason: "test" });
  assert.equal(remove.error, false, remove.data);
  assert.equal((await tool("get_report", { file }, MEMBER)).error, true);
  const undo = await tool("revert_change", { batch: remove.data.batch, reason: "test" });
  assert.equal(undo.error, false, undo.data);
  assert.equal((await tool("get_report", { file }, MEMBER)).data.markdown, markdown);
});

test("one report or attachment can be linked to several people, and unlinked from one only", async () => {
  const markdown = "# Shared example report\n\nAbout two people.";
  const up = await tool("add_report", { person: "I1", also: ["I2"], name: "Shared example.md", markdown }, EDITOR);
  assert.equal(up.error, false, JSON.stringify(up.data));
  const { file } = up.data;
  assert.deepEqual(up.data.people, ["I1", "I2"]);
  const onI1 = (await tool("list_attachments", { person: "I1" }, EDITOR)).data.attachments.find((m) => m.file === file);
  assert.deepEqual(onI1.also_linked_to.map((x) => x.id), ["I2"]);
  assert.ok((await tool("list_attachments", { person: "I2" }, EDITOR)).data.attachments.some((m) => m.file === file));
  // an editor links the existing report to a third person
  const linked = await tool("link_document", { file, people: ["I3"] }, EDITOR);
  assert.equal(linked.error, false, JSON.stringify(linked.data));
  const onI3 = (await tool("list_attachments", { person: "I3" }, EDITOR)).data.attachments.find((m) => m.file === file);
  assert.equal(onI3.caption, "Shared example.md");
  assert.deepEqual(onI3.also_linked_to.map((x) => x.id).sort(), ["I1", "I2"]);
  // unlinking from one person leaves the others, and the file stays readable
  const off = await tool("edit_tree", { ops: [{ op: "media.detach", person: "I1", file }], reason: "test" }, EDITOR);
  assert.equal(off.error, false, JSON.stringify(off.data));
  assert.ok(!(await tool("list_attachments", { person: "I1" }, EDITOR)).data.attachments.some((m) => m.file === file));
  assert.equal((await tool("get_report", { file }, EDITOR)).data.markdown, markdown);
  // text files come back as text, not as an embedded file
  const note = await tool("add_attachment", { person: "I2", name: "Example notes.csv", data_base64: Buffer.from("a,b\n1,2\n").toString("base64") }, EDITOR);
  const read = await tool("get_attachment", { file: note.data.file }, EDITOR);
  assert.equal(read.content[0].type, "text");
  assert.equal(read.data.text, "a,b\n1,2\n");
  // a member can suggest linking a shared document they can see; it waits for review
  const one = (await call("GET", "/api/tree?tree=one", { as: MEMBER })).data.people;
  const [a, b] = Object.values(one).filter((p) => !p.private && !p.living).map((p) => p.id);
  const doc = await tool("add_attachment", { person: a, name: "Example letter.txt", data_base64: Buffer.from("letter").toString("base64"), tree: "one" }, OWNER);
  assert.equal(doc.error, false, JSON.stringify(doc.data));
  const suggested = await tool("link_document", { file: doc.data.file, people: [b], tree: "one" }, MEMBER);
  assert.equal(suggested.error, false, JSON.stringify(suggested.data));
  assert.ok(suggested.data.proposal, "members suggest");
  assert.ok(!(await tool("list_attachments", { person: b, tree: "one" }, MEMBER)).data.attachments.some((m) => m.file === doc.data.file));
  const ok = await tool("review_suggestion", { id: suggested.data.proposal, decision: "approve", tree: "one" });
  assert.equal(ok.error, false, JSON.stringify(ok.data));
  assert.ok((await tool("list_attachments", { person: b, tree: "one" }, MEMBER)).data.attachments.some((m) => m.file === doc.data.file), "approved link appears");
  // a file nobody in this view has attached can't be linked by someone else
  assert.equal((await tool("link_document", { file: `attachments/${crypto.randomUUID()}`, people: ["I3"] }, EDITOR)).error, true);
  // the upload endpoint takes several people too, and refuses people outside the view
  const bad = await tool("add_report", { person: "I1", also: ["I-not-there"], name: "Example.md", markdown }, EDITOR);
  assert.equal(bad.error, true);
});

test("MCP Apps resource is available and record cards preserve the selected tree", async () => {
  const list = await rpc("tools/list", {}, { as: MEMBER });
  const template = list.body.result.tools.find((item) => item.name === "get_person")._meta.ui.resourceUri;
  const resource = await rpc("resources/read", { uri: template }, { as: MEMBER });
  assert.equal(resource.body.result.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(resource.body.result.contents[0].text, /ui\/notifications\/tool-result/);
  assert.ok((await rpc("resources/read", { uri: template }, { as: STRANGER })).body.error);
  // the address changes with the card, and the old fixed one still gets the current card
  assert.match(template, /^ui:\/\/family-tree\/records-[a-z0-9]+\.html$/);
  assert.equal((await rpc("resources/read", { uri: "ui://family-tree/records.html" }, { as: MEMBER })).body.result.contents[0].text, resource.body.result.contents[0].text);
  // cards only on reads: a write's card would only repeat the reply's link
  const tools = Object.fromEntries(list.body.result.tools.map((t) => [t.name, t]));
  for (const name of ["create_todo", "update_todo", "suggest_edit", "add_comment"]) assert.equal(tools[name]._meta, undefined, name);
  assert.ok(tools.get_person._meta && tools.list_todos._meta);
  const person = await tool("get_person", { id: "I4", tree: "one" }, MEMBER);
  assert.equal(person.data.page_url, "https://tree.example.test/?tree=one#/person/I4");
  assert.equal(person.cards[0].page_url, person.data.page_url);
  assert.ok(!person.content.some((item) => item.type === "resource_link" || item.type === "resource"), "record tools return no file-like content");
  assert.match(person.data.events[0].page_url, /#\/person\/I4\?fact=e\d+$/);
  const restricted = await tool("get_person", { id: "I1" }, NAMES);
  assert.equal(restricted.cards.length, 1);
  assert.equal(restricted.cards[0].detail, undefined);
  assert.equal((await tool("get_person", { id: "I1" }, MEMBER)).cards.length, 0);
  const source = await tool("get_source", { id: "S2" });
  assert.match(source.cards[0].page_url, /#\/source\/S2$/);
  const story = await tool("get_story", { slug: "eva-comes-to-england" });
  assert.match(story.cards[0].page_url, /#\/story\/eva-comes-to-england$/);
  assert.ok(story.cards[0].detail);
  const fallback = await rpc("tools/call", { name: "get_person", arguments: { id: "I4" } },
    { headers: { "MCP-Protocol-Version": "2024-11-05" } });
  assert.ok(fallback.body.result.content.every((item) => item.type === "text"));
  assert.match(JSON.parse(fallback.body.result.content[0].text).page_url, /#\/person\/I4$/);
});

test("person.update previews and edits person status with evidence and supports undo", async () => {
  const person = "I4";
  const before = (await tool("get_person", { id: person })).data;
  const set = { research_status: "disputed", status_note: "The example records disagree." };
  const ops = [{ op: "person.update", id: person, set }];
  const preview = await tool("preview_edit", { ops }, EDITOR);
  assert.equal(preview.error, false, preview.data);
  assert.equal(preview.data.touched[0].type, "status");
  assert.deepEqual(preview.data.touched[0].after, { status: set.research_status, note: set.status_note });

  const evidence = [{ title: "Example register", note: "Page 8" }];
  const saved = await tool("edit_tree", { ops, reason: "Check conflicting records", sources: evidence }, EDITOR);
  assert.equal(saved.error, false, saved.data);
  const result = (await tool("get_person", { id: person })).data;
  assert.equal(result.research_status, set.research_status);
  assert.equal(result.status_note, set.status_note);
  const logged = (await tool("get_history", { id: person }, EDITOR)).data.history.find((h) => h.batch === saved.data.batch);
  assert.equal(logged.reason, "Check conflicting records");
  assert.deepEqual(logged.sources, evidence);
  assert.equal(logged.entities[0].type, "status");

  const downgrade = await tool("edit_tree", {
    reason: "Resolve the conflict", ops: [{ op: "person.update", id: person, set: { research_status: "partly-verified" } }],
  }, EDITOR);
  assert.equal(downgrade.error, false, downgrade.data);
  assert.equal((await tool("get_person", { id: person })).data.status_note, set.status_note);
  assert.equal((await tool("revert_change", { batch: saved.data.batch }, EDITOR)).error, true);
  assert.equal((await tool("revert_change", { batch: downgrade.data.batch }, EDITOR)).error, false);
  assert.equal((await tool("revert_change", { batch: saved.data.batch }, EDITOR)).error, false);
  const restored = (await tool("get_person", { id: person })).data;
  assert.equal(restored.research_status, before.research_status);
  assert.equal(restored.status_note, before.status_note);
});

test("unknown person.update fields fail explicitly and status suggestions require approval", async () => {
  const person = "I17";
  const before = (await tool("get_person", { id: person }, MEMBER)).data;
  const bad = [{ op: "person.update", id: person, set: { notes: "Should not save", research_stauts: "verified" } }];
  assert.match((await tool("preview_edit", { ops: bad }, MEMBER)).data, /unknown person.update set fields: research_stauts/);
  assert.equal((await tool("edit_tree", { ops: bad, reason: "test" }, EDITOR)).error, true);
  assert.deepEqual((await tool("get_person", { id: person }, MEMBER)).data.notes, before.notes);
  const invalid = [{ op: "person.update", id: person, set: { research_status: "wrong" } }];
  assert.match((await tool("preview_edit", { ops: invalid }, MEMBER)).data, /research_status must be one of/);

  const ops = [{ op: "person.update", id: person, set: { research_status: "verified", status_note: null } }];
  const proposed = await tool("suggest_edit", { ops, reason: "Example status review" }, MEMBER);
  assert.equal(proposed.error, false, proposed.data);
  assert.equal((await tool("get_person", { id: person }, MEMBER)).data.research_status, before.research_status);
  const approved = await tool("review_suggestion", { id: proposed.data.proposal.id, decision: "approve", tree: "one" });
  assert.equal(approved.error, false, approved.data);
  const updated = (await tool("get_person", { id: person }, MEMBER)).data;
  assert.equal(updated.research_status, "verified");
  assert.equal(updated.status_note, undefined);
});

test("reports link existing sources on upload or through a later media edit", async () => {
  const args = { person: "I4", name: "Example citation.md", markdown: "# Example transcription" };
  const count = env.MEDIA.objects.size;
  assert.equal((await tool("add_report", { ...args, source: "S-not-found" })).error, true);
  assert.equal(env.MEDIA.objects.size, count);

  const uploaded = await tool("add_report", { ...args, source: "S2" }, EDITOR);
  assert.equal(uploaded.error, false, uploaded.data);
  const { file } = uploaded.data;
  const report = (await tool("get_report", { file })).data;
  assert.equal(report.source, "S2");
  assert.match(report.source_url, /#\/source\/S2$/);
  const source = (await tool("get_source", { id: "S2" })).data;
  assert.ok(source.cited_by.some((use) => use.file === file && use.where === "report" && use.page_url.includes("attachment=")));

  const existing = await tool("add_report", { ...args, name: "Another example.md" }, EDITOR);
  const set = [{ op: "media.update", person: args.person, file: existing.data.file, set: { source: "S2" } }];
  const edit = await tool("edit_tree", { ops: set, reason: "Link the example register" }, EDITOR);
  assert.equal(edit.error, false, edit.data);
  assert.equal((await tool("get_report", { file: existing.data.file })).data.source, "S2");
  assert.equal((await tool("revert_change", { batch: edit.data.batch }, EDITOR)).error, false);
  assert.equal((await tool("get_report", { file: existing.data.file })).data.source, undefined);
});

test("malformed RPC messages and tool notifications cannot perform writes", async () => {
  const scalar = await rpc(null, null, { raw: '"invalid request"' });
  assert.equal(scalar.body.error.code, -32600);
  const noId = await rpc(null, null, { raw: JSON.stringify({
    jsonrpc: "2.0", method: "tools/call", params: { name: "create_todo", arguments: { task: "Example notification task" } },
  }) });
  assert.equal(noId.status, 202);
  const todos = (await tool("list_todos")).data.todos;
  assert.ok(!todos.some((todo) => todo.task === "Example notification task"));
});

test("every advertised tool rejects input outside its published top-level schema", async (t) => {
  const { tools } = (await rpc("tools/list", {}, { as: OWNER })).body.result;
  assert.equal(new Set(tools.map(({ name }) => name)).size, tools.length);
  for (const { name, inputSchema } of tools) {
    await t.test(name, async () => {
      assert.equal(inputSchema.type, "object");
      const required = inputSchema.required || [];
      const present = Object.fromEntries(required.map((field) => [field, null]));
      const bad = await tool(name, { unexpected_test_field: true, ...present });
      assert.equal(bad.error, true);
      assert.match(bad.data, /unknown field "unexpected_test_field"/);
      for (const field of required) {
        assert.ok(Object.hasOwn(inputSchema.properties, field));
      }
      if (required.length) {
        const missing = await tool(name);
        assert.equal(missing.error, true);
        assert.ok(missing.data.includes(`${required[0]} is required`));
      }
    });
  }
});

test("every tool omitted for a role is also denied when called directly", async () => {
  const listed = async (as) => (await rpc("tools/list", {}, { as })).body.result.tools.map(({ name }) => name);
  const all = await listed(OWNER);
  for (const as of [EDITOR, MEMBER, NAMES, STRANGER]) {
    const visible = new Set(await listed(as));
    const omitted = all.filter((name) => !visible.has(name));
    assert.ok(omitted.length);
    for (const name of omitted) {
      const denied = await tool(name, {}, as);
      assert.equal(denied.error, true, `${name} accepted an unlisted call`);
      assert.match(denied.data, /needs a role you don't have/);
    }
  }
});

// ---- getting files in without writing them out as base64 (worker/upload-slots.js, url on upload tools)
const put = (link, bytes, method = "PUT") => worker.fetch(new Request(link, { method, ...(method === "GET" ? {} : { body: bytes }) }), env, { waitUntil() {} });

test("upload link: the file goes in with one PUT, as the member who asked, without location data, once", async () => {
  const photo = readFileSync(join(ROOT, "tests", "fixtures", "gps.jpg"));
  const link = await tool("get_upload_link", { person: "I4", name: "Draft card.jpg", title: "Example draft card" }, EDITOR);
  assert.equal(link.error, false, link.data);
  assert.match(link.data.upload_url, /^https:\/\/tree\.example\.test\/upload\/[\w-]{40,}$/);
  assert.match(link.data.command, /^curl .*-T '<path to the file>'/);
  // no Access session needed: the token is the credential
  const res = await put(link.data.upload_url, photo);
  assert.equal(res.status, 201, await res.clone().text());
  const out = await res.json();
  assert.ok(out.batch, "an editor's attachment is added directly");
  const stored = Buffer.from(await (await env.MEDIA.get(out.file)).arrayBuffer());
  assert.ok(!stored.includes("ExampleCam"));
  assert.equal((await put(link.data.upload_url, photo)).status, 404, "a link works once");
  assert.equal((await put(link.data.upload_url.replace(/.$/, "x"), photo)).status, 404, "a made-up token does nothing");
});

test("upload link: a member's upload is a suggestion; a failed upload leaves the link usable; expired links don't work", async () => {
  const link = (await tool("get_upload_link", { person: "I17", name: "letter.pdf" }, MEMBER)).data;
  assert.ok(link.upload_url, JSON.stringify(link));
  assert.equal((await put(link.upload_url, new Uint8Array(0))).status, 400, "empty");
  const res = await put(link.upload_url, new TextEncoder().encode("%PDF-1.4 example letter"));
  assert.equal(res.status, 201);
  assert.ok((await res.json()).proposal, "members' attachments go to review");

  const photo = (await tool("get_upload_link", { kind: "photo", name: "notes.txt" }, EDITOR)).data;
  assert.equal((await put(photo.upload_url, new TextEncoder().encode("not a picture"))).status, 415);
  const ok = await put(photo.upload_url, readFileSync(join(ROOT, "tests", "fixtures", "gps.png")));
  assert.equal(ok.status, 201, "still usable after the refused file");
  assert.match((await ok.json()).key, /^uploads\/.*\.png$/);

  const old = (await tool("get_upload_link", { person: "I1", name: "late.pdf" }, EDITOR)).data;
  await env.DB.prepare("UPDATE upload_slots SET expires_at = ?").bind("2000-01-01T00:00:00Z").run();
  assert.equal((await put(old.upload_url, new TextEncoder().encode("%PDF-1.4"))).status, 404);
  assert.equal((await put(old.upload_url, new TextEncoder().encode("%PDF-1.4"), "GET")).status, 405);
});

test("upload link: only for people in the member's view, and attachments need a person", async () => {
  assert.equal((await tool("get_upload_link", { name: "x.pdf" }, EDITOR)).error, true);
  assert.equal((await tool("get_upload_link", { person: "I99999", name: "x.pdf" }, EDITOR)).error, true);
});

test("url: the server downloads public https files itself, and refuses this site, addresses and plain http", async () => {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (u) => {
    const url = String(u);
    seen.push(url);
    if (url === "https://archive.example.org/moved") return new Response(null, { status: 302, headers: { Location: "/images/Record%201.png" } });
    if (url === "https://archive.example.org/images/Record%201.png") return new Response(readFileSync(join(ROOT, "tests", "fixtures", "gps.png")), { headers: { "Content-Type": "image/png" } });
    if (url === "https://archive.example.org/sneaky") return new Response(null, { status: 302, headers: { Location: "https://tree.example.test/api/tree" } });
    if (url === "https://archive.example.org/private") return new Response("sign in", { status: 403 });
    return real(u);
  };
  try {
    const up = await tool("add_attachment", { person: "I4", url: "https://archive.example.org/moved" }, EDITOR);
    assert.equal(up.error, false, up.data);
    assert.equal(up.data.people[0], "I4");
    assert.ok(!Buffer.from(await (await env.MEDIA.get(up.data.file)).arrayBuffer()).includes("ExampleCam"));
    const media = await tool("upload_media", { url: "https://archive.example.org/images/Record%201.png" }, EDITOR);
    assert.match(media.data.key, /Record-1\.png$|\.png$/);
    for (const url of ["https://archive.example.org/sneaky", "http://archive.example.org/x", "https://127.0.0.1/x", "https://tree.example.test/media/x", "https://localhost/x", "https://user:pw@archive.example.org/x"]) {
      const r = await tool("add_attachment", { person: "I4", url, name: "x.png" }, EDITOR);
      assert.equal(r.error, true, url);
    }
    assert.ok(!seen.some((u) => u.includes("tree.example.test") || u.startsWith("http:") || u.includes("127.0.0.1")), "never fetched");
    const denied = await tool("add_attachment", { person: "I4", url: "https://archive.example.org/private" }, EDITOR);
    assert.equal(denied.error, true);
    assert.match(JSON.stringify(denied.data), /get_upload_link/);
    assert.equal((await tool("add_attachment", { person: "I4", name: "x.png" }, EDITOR)).error, true, "no file at all");
    assert.equal((await tool("add_attachment", { person: "I4", name: "x.png", url: "https://archive.example.org/moved", data_base64: "AAAA" }, EDITOR)).error, true, "two files");
  } finally {
    globalThis.fetch = real;
  }
});

// ---- attachments that are images show in the person page's gallery (worker/index.js markImageAttachments)
const site = (path, init = {}) => worker.fetch(new Request(`https://tree.example.test${path}`, { ...init, headers: { "X-Dev-Principal": OWNER, ...(init.headers || {}) } }), env, { waitUntil() {} });
const attachFile = async (person, name, bytes) => (await (await site(`/api/attachments?person=${person}&type=attachment&tree=all`, {
  method: "POST", body: bytes, headers: { "X-Document-Name": encodeURIComponent(name), "X-Document-Title": "" } })).json());
const mediaOf = async (person) => (await (await site("/api/tree?tree=all")).json()).research.media[person] || [];

test("image attachments: marked for the gallery, shown inline only when the bytes are an image, location data removed", async () => {
  const photo = readFileSync(join(ROOT, "tests", "fixtures", "gps.jpg"));
  const up = await attachFile("I2", "draft card", photo); // no extension: recognised from the bytes
  assert.ok(up.file, JSON.stringify(up));
  const row = await env.DB.prepare("SELECT content_type FROM uploads WHERE key = ?").bind(up.file).first();
  assert.equal(row.content_type, "image/jpeg");
  assert.ok(!Buffer.from(await (await env.MEDIA.get(up.file)).arrayBuffer()).includes("ExampleCam"), "site attachments lose location data too");
  const pdf = await attachFile("I2", "notes.pdf", new TextEncoder().encode("%PDF-1.4 example"));
  const fake = await attachFile("I2", "trick.png", new TextEncoder().encode("<svg onload=alert(1)>")); // named like an image
  const items = Object.fromEntries((await mediaOf("I2")).map((m) => [m.file, m]));
  assert.equal(items[up.file].image, true);
  assert.equal(items[pdf.file].image, undefined);
  assert.equal(items[fake.file].image, true, "the name says image, so the page tries; /media checks the bytes");

  const inline = await site(`/media/${up.file}?tree=all&inline=1`);
  assert.equal(inline.headers.get("Content-Type"), "image/jpeg");
  assert.match(inline.headers.get("Content-Disposition"), /^inline;/);
  assert.equal(inline.headers.get("X-Content-Type-Options"), "nosniff");
  const trick = await site(`/media/${fake.file}?tree=all&inline=1`);
  assert.equal(trick.headers.get("Content-Type"), "application/octet-stream");
  assert.match(trick.headers.get("Content-Disposition"), /^attachment;/);
  const download = await site(`/media/${up.file}?tree=all`);
  assert.match(download.headers.get("Content-Disposition"), /^attachment;/, "without inline=1 it's still a download");
});

test("image attachments uploaded before images were recorded are checked once from their first bytes", async () => {
  const photo = readFileSync(join(ROOT, "tests", "fixtures", "gps.png"));
  const old = await attachFile("I3", "scan", photo);
  const pdf = await attachFile("I3", "letter", new TextEncoder().encode("%PDF-1.4 example"));
  // as an older upload recorded them
  await env.DB.prepare("UPDATE uploads SET content_type = 'application/octet-stream' WHERE key IN (?, ?)").bind(old.file, pdf.file).run();
  const items = Object.fromEntries((await mediaOf("I3")).map((m) => [m.file, m]));
  assert.equal(items[old.file].image, true);
  assert.equal(items[pdf.file].image, undefined);
  const types = Object.fromEntries((await env.DB.prepare("SELECT key, content_type FROM uploads WHERE key IN (?, ?)").bind(old.file, pdf.file).all()).results.map((r) => [r.key, r.content_type]));
  assert.equal(types[old.file], "image/png");
  assert.equal(types[pdf.file], "application/octet-stream; checked");
  const reads = env.MEDIA.reads;
  await mediaOf("I3");
  assert.equal(env.MEDIA.reads, reads, "not read again");
});
