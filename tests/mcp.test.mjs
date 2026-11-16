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
  return { error: !!res.isError, data, content: res.content };
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
  assert.deepEqual(s.people.find((x) => x.id === "I2"), { id: "I2", name: "Daniel James Hartley", private: true });
  assert.ok(!(await tool("search_events", {}, NAMES)).data.events.some((e) => e.person && ["I1", "I2", "I3", "I16"].includes(e.person.id)));
  assert.equal((await tool("get_timeline", { id: "I2" }, NAMES)).data.events.length, 0);
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

test("exports respect the caller's view", async () => {
  const ged = (await tool("export_tree", { tree: "all" }, EDITOR)).data;
  assert.match(ged, /^0 HEAD/);
  assert.equal((await tool("export_tree", {}, MEMBER)).error, true);
});
