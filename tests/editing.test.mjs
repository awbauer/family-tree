// Editing, suggestions of tree edits, history/revert, fact review, comments, uploads, graph, export, admin.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEnv, client, migrate } from "./helpers/fake-env.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "owner@example.test", EDITOR = "editor@example.test", MEMBER = "member@example.test", AGENT = "agent:research";
let env, call, ex, any, kid, fam;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ft-ed-"));
  execFileSync("python3", ["tools/build.py", "--data", "example", "--out", dir, "--raw-out", join(dir, "raw.json")], { cwd: ROOT });
  const research = JSON.parse(readFileSync(join(ROOT, "example/research.json"), "utf8"));
  research.trees = [{ id: "all", name: "Everyone", definition: { branches: ["*"] } }, { id: "one", name: "One branch", definition: { branches: [research.branches[0].key] } }];
  writeFileSync(join(dir, "research.json"), JSON.stringify(research));
  execFileSync("python3", ["tools/seed_app.py", "--raw", join(dir, "raw.json"), "--bundle", join(dir, "family.json"), "--research", join(dir, "research.json"), "--out", join(dir, "seed.sql"), "--owner", OWNER, "--cutover"], { cwd: ROOT });
  env = makeEnv();
  migrate(env.DB, ROOT);
  env.DB.execFile(join(dir, "seed.sql"));
  call = client((await import("../worker/index.js")).default, env);
  ex = JSON.parse(readFileSync(join(dir, "family.json"), "utf8"));
  await call("PUT", "/api/admin/grants", { body: { principal: EDITOR, tree_id: "all", role: "editor" } });
  await call("PUT", "/api/admin/grants", { body: { principal: MEMBER, tree_id: "all", role: "member" } });
  await call("PUT", "/api/admin/members/agent%3Aresearch", { body: { kind: "agent" } });
  await call("PUT", "/api/admin/grants", { body: { principal: AGENT, tree_id: "all", role: "agent" } });
  fam = Object.values(ex.families).find((f) => f.husband && f.wife && f.children.length);
  kid = fam.children[0];
  any = fam.husband;
});

const person = async (id, as = OWNER) => (await call("GET", "/api/tree?tree=all", { as })).data.people[id];

test("events and names carry stable fact ids after import", async () => {
  const p = await person(any);
  assert.ok(p.events.every((e) => /^e\d+$/.test(e.fid)));
  assert.ok(p.names.every((n) => /^n\d+$/.test(n.fid)));
});

test("an editor edits directly; the change is in history and can be reverted", async () => {
  const r = await call("POST", "/api/edit", { as: EDITOR, body: { tree: "all", reason: "found a burial record", sources: [{ title: "Burial register", note: "p. 3" }],
    ops: [{ op: "event.add", entity: "person", id: any, event: { type: "Burial", date: "3 Mar 1931", place: "Leeds" } }] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let p = await person(any);
  const burial = p.events.find((e) => e.type === "Burial" && e.date === "3 Mar 1931");
  assert.ok(burial && burial.fid);
  const h = await call("GET", `/api/history?tree=all&id=${any}`, { as: EDITOR });
  assert.equal(h.data.history[0].reason, "found a burial record");
  const rv = await call("POST", `/api/changes/${r.data.batch}/revert`, { as: EDITOR });
  assert.equal(rv.status, 200, JSON.stringify(rv.data));
  p = await person(any);
  assert.ok(!p.events.some((e) => e.date === "3 Mar 1931"));
});

test("edits need a reason; bad ops are rejected atomically", async () => {
  assert.equal((await call("POST", "/api/edit", { as: EDITOR, body: { tree: "all", ops: [{ op: "person.update", id: any, set: { sex: "M" } }] } })).status, 400);
  const before = await person(any);
  const bad = await call("POST", "/api/edit", { as: EDITOR, body: { tree: "all", reason: "x", ops: [
    { op: "event.add", entity: "person", id: any, event: { type: "Residence", date: "1901" } },
    { op: "event.remove", entity: "person", id: any, fid: "e999" }] } });
  assert.equal(bad.status, 422);
  assert.deepEqual((await person(any)).events.length, before.events.length, "first op must not have been applied");
});

test("reverting is refused when later changes touched the same record", async () => {
  const a = await call("POST", "/api/edit", { as: EDITOR, body: { tree: "all", reason: "a", ops: [{ op: "event.add", entity: "person", id: any, event: { type: "Residence", date: "1911" } }] } });
  const b = await call("POST", "/api/edit", { as: EDITOR, body: { tree: "all", reason: "b", ops: [{ op: "event.add", entity: "person", id: any, event: { type: "Residence", date: "1921" } }] } });
  assert.equal(b.status, 200);
  assert.equal((await call("POST", `/api/changes/${a.data.batch}/revert`, { as: EDITOR })).status, 409);
  assert.equal((await call("POST", `/api/changes/${b.data.batch}/revert`, { as: EDITOR })).status, 200);
  assert.equal((await call("POST", `/api/changes/${a.data.batch}/revert`, { as: EDITOR })).status, 200);
});

test("members and agents can't edit directly, but can suggest; an editor approves", async () => {
  const ops = [{ op: "event.add", entity: "person", id: kid, event: { type: "Occupation", value: "Weaver", date: "1911" } }];
  assert.equal((await call("POST", "/api/edit", { as: MEMBER, body: { tree: "all", reason: "x", ops } })).status, 403);
  assert.equal((await call("POST", "/api/edit", { as: AGENT, body: { tree: "all", reason: "x", ops } })).status, 403);
  const bad = await call("POST", "/api/proposals", { as: AGENT, body: { tree: "all", kind: "edit", payload: { ops: [{ op: "family.delete", family: "NOPE" }] } } });
  assert.equal(bad.status, 403); // NOPE isn't visible -> scope check first
  const pr = await call("POST", "/api/proposals", { as: AGENT, body: { tree: "all", kind: "edit", payload: { reason: "1911 census", ops }, rationale: "occupation from census" } });
  assert.equal(pr.status, 201, JSON.stringify(pr.data));
  assert.equal((await call("POST", `/api/proposals/${pr.data.proposal.id}/approve`, { as: MEMBER })).status, 403);
  const ok = await call("POST", `/api/proposals/${pr.data.proposal.id}/approve`, { as: EDITOR });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.ok((await person(kid)).events.some((e) => e.type === "Occupation" && e.value === "Weaver"));
});

test("fact review and citations are ops too", async () => {
  const p = await person(any);
  const fid = p.events[0].fid;
  const r = await call("POST", "/api/edit", { as: EDITOR, body: { tree: "all", reason: "checked the register", ops: [
    { op: "citation.add", entity: "person", id: any, fid, citation: { url: "https://example.org/register/12", note: "entry 12" } },
    { op: "fact.review", entity: "person", id: any, fid, status: "verified", note: "image viewed" }] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const e = (await person(any)).events.find((x) => x.fid === fid);
  assert.equal(e.review.status, "verified");
  assert.equal(e.review.by, EDITOR);
  assert.ok(e.citations.some((c) => c.note === "entry 12"));
});

test("create a person and link them as a child, then merge a duplicate", async () => {
  const r = await call("POST", "/api/edit", { as: OWNER, body: { tree: "all", reason: "new child from census", ops: [
    { op: "person.create", id: "$k", names: [{ given: "Edith", surname: "Testcase" }], sex: "F", events: [{ type: "Birth", date: "1905" }] },
    { op: "family.add_child", family: fam.id, person: "$k" },
    { op: "person.create", id: "$d", names: [{ given: "Edie", surname: "Testcase" }], sex: "F" }] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const k = r.data.created.$k, d = r.data.created.$d;
  const t = (await call("GET", "/api/tree?tree=all")).data;
  assert.ok(t.families[fam.id].children.includes(k));
  assert.deepEqual(t.people[k].famc, [fam.id]);
  // research filed under the duplicate must follow the merge
  await call("POST", "/api/todos?tree=all", { body: { person: d, task: "Check the duplicate's baptism", priority: "low" } });
  await call("POST", "/api/comments", { body: { tree: "all", type: "person", id: d, body: "Probably the same Edith." } });
  env.DB.db.prepare("INSERT INTO findings (person_id, data, created_at, created_by) VALUES (?, ?, ?, ?)").run(d, JSON.stringify({ person: d, kind: "new-fact", finding: "dup finding", confidence: "low", sources: [{ title: "x", note: "y" }] }), "2026-01-01", "test");
  env.DB.db.prepare("INSERT INTO statuses (person_id, data) VALUES (?, ?)").run(d, JSON.stringify({ status: "partly-verified", note: "from dup" }));
  const m = await call("POST", "/api/edit", { as: OWNER, body: { tree: "all", reason: "same person", ops: [{ op: "person.merge", keep: k, drop: d }] } });
  assert.equal(m.status, 200, JSON.stringify(m.data));
  const t2 = (await call("GET", "/api/tree?tree=all")).data;
  assert.ok(!t2.people[d]);
  assert.ok(t2.people[k].names.some((n) => n.given === "Edie"));
  assert.equal(t2.aliases[d], k);
  assert.ok(t2.research.todo.some((x) => x.person === k && x.task.startsWith("Check the duplicate")), "to-do follows the merge");
  assert.ok(t2.research.findings.some((f) => f.person === k && f.finding === "dup finding"), "finding follows the merge");
  assert.equal(t2.people[k].status, "partly-verified", "status follows the merge");
  const cm = await call("GET", `/api/comments?tree=all&type=person&id=${k}`);
  assert.ok(cm.data.comments.some((x) => x.body === "Probably the same Edith."), "comment follows the merge");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) n FROM findings WHERE person_id = ?").bind(d).first()).n, 0);
});

test("comments on people and facts, resolved by author or editor", async () => {
  const c = await call("POST", "/api/comments", { as: MEMBER, body: { tree: "all", type: "person", id: any, fid: "e1", body: "Grandma always said he was born in Halifax." } });
  assert.equal(c.status, 201);
  const l = await call("GET", `/api/comments?tree=all&type=person&id=${any}`, { as: OWNER });
  assert.equal(l.data.comments.at(-1).fid, "e1");
  assert.equal((await call("POST", `/api/comments/${c.data.comment.id}/resolve`, { as: EDITOR })).status, 200);
});

test("uploads go to R2 under uploads/; attaching makes them visible, not before", async () => {
  const res = await (await import("../worker/index.js")).default.fetch(new Request(`https://x.test/api/media/upload?tree=all&name=grave.jpg`, {
    method: "POST", headers: { "X-Dev-Principal": EDITOR, "Content-Type": "image/jpeg" }, body: new Uint8Array([255, 216, 255, 0]) }), env, {});
  assert.equal(res.status, 201);
  const { key } = await res.json();
  assert.match(key, /^uploads\/\d{4}-\d{2}\/[\w-]+-grave\.jpg$/);
  assert.equal((await call("GET", `/media/${key}`)).status, 404);
  const a = await call("POST", "/api/edit", { as: EDITOR, body: { tree: "all", reason: "grave photo", ops: [{ op: "media.attach", person: any, file: key, caption: "Grave" }] } });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal((await call("GET", `/media/${key}`)).status, 200);
  const bad = await (await import("../worker/index.js")).default.fetch(new Request(`https://x.test/api/media/upload?tree=all`, {
    method: "POST", headers: { "X-Dev-Principal": EDITOR, "Content-Type": "text/html" }, body: "<script>" }), env, {});
  assert.equal(bad.status, 415);
});

test("graph: relationship path between two visible people", async () => {
  const r = await call("GET", `/api/graph/path?tree=all&from=${kid}&to=${fam.wife}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.found, true);
  assert.equal(r.data.steps.length, 1);
  assert.match(r.data.sentence, /mother/i);
});

test("GEDCOM export is scoped and editor-only; JSON export is owner-only", async () => {
  assert.equal((await call("GET", "/api/export.ged?tree=all", { as: MEMBER })).status, 403);
  const g = await call("GET", "/api/export.ged?tree=all", { as: EDITOR });
  assert.equal(g.status, 200);
  assert.match(g.data, /^0 HEAD/);
  assert.equal((await call("GET", "/api/export.json", { as: EDITOR })).status, 403);
  const j = await call("GET", "/api/export.json");
  assert.equal(j.data.format, "family-tree-export/1");
  assert.ok(Object.keys(j.data.raw.people).length > 0);
});

test("link me to my person, preview a view (owner only), invite without an API token", async () => {
  assert.equal((await call("PUT", "/api/me/person", { as: MEMBER, body: { tree: "all", person_id: kid } })).status, 200);
  assert.equal((await call("GET", "/api/me", { as: MEMBER })).data.personId, kid);
  await call("PUT", "/api/admin/views/names", { body: { name: "Names only", filter: { living: "names-only", research: false } } });
  assert.equal((await call("GET", "/api/tree?tree=all&preview_view=names", { as: MEMBER })).status, 403);
  const pv = await call("GET", "/api/tree?tree=all&preview_view=names");
  assert.equal(pv.status, 200);
  assert.equal(pv.data.research.findings.length, 0);
  const inv = await call("PUT", "/api/admin/grants", { body: { principal: "new@example.test", tree_id: "one", role: "member", invite: true } });
  assert.equal(inv.data.access.automated, false);
});
