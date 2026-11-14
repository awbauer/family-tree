// End-to-end tests of the Worker against the fictional example family, on an in-memory SQLite "D1".
//   npm test        (needs python3 for the example build)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEnv, client } from "./helpers/fake-env.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "owner@example.test", MEMBER = "cousin@example.test", AGENT = "service:research-agent", STRANGER = "nobody@example.test";
let env, call, worker, ex;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ft-"));
  execFileSync("python3", ["tools/build.py", "--data", "example", "--out", dir, "--raw-out", join(dir, "raw.json")], { cwd: ROOT });
  // two trees for the example: everything, and one branch only
  const research = JSON.parse(readFileSync(join(ROOT, "example/research.json"), "utf8"));
  ex = { research, bundle: JSON.parse(readFileSync(join(dir, "family.json"), "utf8")) };
  const branchKey = research.branches[0].key;
  research.trees = [{ id: "all", name: "Everyone", definition: { branches: ["*"] } },
    { id: "one", name: "One branch", definition: { branches: [branchKey] } }];
  writeFileSync(join(dir, "research.json"), JSON.stringify(research));
  execFileSync("python3", ["tools/seed_app.py", "--raw", join(dir, "raw.json"), "--bundle", join(dir, "family.json"),
    "--research", join(dir, "research.json"), "--out", join(dir, "seed.sql"), "--owner", OWNER, "--cutover"], { cwd: ROOT });
  env = makeEnv();
  env.DB.execFile(join(ROOT, "migrations/0001_app_schema.sql"));
  env.DB.execFile(join(dir, "seed.sql"));
  worker = (await import("../worker/index.js")).default;
  call = client(worker, env);
  // a cousin who may only see one branch, with living people reduced to names; and a research agent
  await call("PUT", "/api/admin/views/cousins", { body: { name: "Cousins", filter: { living: "names-only", research: false } } });
  await call("PUT", "/api/admin/grants", { body: { principal: MEMBER, tree_id: "one", role: "member", view_id: "cousins" } });
  await call("PUT", "/api/admin/members/" + encodeURIComponent(AGENT), { body: { kind: "agent", display_name: "Research agent" } });
  await call("PUT", "/api/admin/grants", { body: { principal: AGENT, tree_id: "all", role: "agent" } });
});

test("owner sees every tree and the whole family", async () => {
  const me = await call("GET", "/api/me");
  assert.equal(me.status, 200);
  assert.equal(me.data.isOwner, true);
  assert.deepEqual(me.data.trees.map((t) => t.id).sort(), ["all", "one"]);
  const t = await call("GET", "/api/tree?tree=all");
  assert.equal(t.status, 200);
  assert.equal(Object.keys(t.data.people).length, Object.keys(ex.bundle.people).length);
});

test("no grant means no data", async () => {
  const t = await call("GET", "/api/tree", { as: STRANGER });
  assert.equal(t.status, 403);
  const m = await call("GET", "/api/me", { as: STRANGER });
  assert.deepEqual(m.data.trees, []);
});

test("Access is required unless explicitly disabled for local dev", async () => {
  const strict = makeEnv({ ALLOW_UNAUTHENTICATED: "false" });
  const res = await worker.fetch(new Request("https://x.test/api/tree"), strict, {});
  assert.equal(res.status, 403);
});

test("a scoped member sees only their tree, through their view, with no leaks", async () => {
  const t = await call("GET", "/api/tree", { as: MEMBER });
  assert.equal(t.status, 200);
  const all = ex.bundle.people;
  const branchKey = ex.research.branches[0].key;
  const visible = new Set(Object.keys(t.data.people));
  assert.ok(visible.size > 0 && visible.size < Object.keys(all).length);
  for (const id of visible) assert.equal(all[id].branch, branchKey);
  // living people are names only
  for (const p of Object.values(t.data.people)) if (p.living) {
    assert.equal(p.events.length, 0); assert.equal(p.birth, null);
  }
  // research hidden by the view
  assert.equal(t.data.research.findings.length, 0);
  assert.equal(t.data.research.todo.length, 0);
  // leak check: no hidden ID or (unique) name anywhere in the payload
  const text = JSON.stringify(t.data);
  const visibleNames = new Set(Object.values(t.data.people).map((p) => p.name));
  for (const [id, p] of Object.entries(all)) {
    if (visible.has(id)) continue;
    assert.ok(!new RegExp(`\\b${id}\\b`).test(text), `hidden id ${id} leaked`);
    if (p.name && p.name !== "Unknown" && p.name.length >= 5 && !visibleNames.has(p.name)) assert.ok(!text.includes(p.name), `hidden name of ${id} leaked`);
  }
  // relationship labels are relative to the tree, never to the owner's home person
  assert.notEqual(t.data.home, undefined);
});

test("members can't reach other trees or admin", async () => {
  assert.equal((await call("GET", "/api/tree?tree=all", { as: MEMBER })).status, 403);
  assert.equal((await call("GET", "/api/admin", { as: MEMBER })).status, 403);
});

test("to-dos: imported, listed, assigned to me, edited with version checks", async () => {
  const list = await call("GET", "/api/todos?tree=all&status=active");
  assert.equal(list.status, 200);
  assert.equal(list.data.todos.length, ex.research.todo.length);
  const first = list.data.todos[0];
  const a = await call("PATCH", `/api/todos/${first.id}`, { body: { version: first.version, assignee: "me" } });
  assert.equal(a.status, 200);
  assert.equal(a.data.todo.assignee, OWNER);
  const mine = await call("GET", "/api/todos?tree=all&assignee=me");
  assert.ok(mine.data.todos.some((t) => t.id === first.id));
  const stale = await call("PATCH", `/api/todos/${first.id}`, { body: { version: first.version, priority: "low" } });
  assert.equal(stale.status, 409);
  const created = await call("POST", "/api/todos?tree=all", { body: { task: "Check the parish register", priority: "high", assignee: "me" } });
  assert.equal(created.status, 201);
  assert.equal(created.data.todo.status, "open");
  const ev = await call("GET", `/api/todos/${created.data.todo.id}/events`);
  assert.equal(ev.data.events[0].kind, "created");
});

test("agents work the queue: claim, submit research, can't close; an editor approves", async () => {
  const q = await call("GET", "/api/queue?tree=all", { as: AGENT });
  assert.equal(q.status, 200);
  const job = q.data.available.find((t) => t.person);
  assert.ok(job, "an unassigned to-do with a person");
  const claim = await call("POST", `/api/todos/${job.id}/claim`, { as: AGENT });
  assert.equal(claim.status, 200);
  assert.equal(claim.data.todo.assignee, AGENT);
  assert.equal(claim.data.todo.status, "in_progress");
  // someone else can't claim it now
  assert.equal((await call("POST", `/api/todos/${job.id}/claim`, { as: MEMBER })).status, 404); // member can't even see it (research hidden)
  // agents can't mark done
  const done = await call("PATCH", `/api/todos/${job.id}`, { as: AGENT, body: { status: "done" } });
  assert.equal(done.status, 403);
  // a bad batch is rejected with reasons
  const bad = await call("POST", "/api/proposals", { as: AGENT, body: { tree: "all", payload: { findings: [{ person: job.person, kind: "guess", confidence: "high", finding: "x", sources: [] }] } } });
  assert.equal(bad.status, 422);
  assert.ok(bad.data.errors.length >= 2);
  // a good batch goes to the review queue and moves the to-do to needs_review
  const batch = {
    branch: job.branch, agent: "research-agent",
    findings: [{ person: job.person, kind: "new-fact", field: "test", claim: "none", finding: "A test finding from the agent.", confidence: "low", sources: [{ title: "Test register", note: "page 1" }] }],
    log: [{ person: job.person, question: "q", searched: "Test register 1900-1910", result: "found" }],
  };
  const prop = await call("POST", "/api/proposals", { as: AGENT, body: { tree: "all", payload: batch, todo_id: job.id, rationale: "worked the to-do" } });
  assert.equal(prop.status, 201);
  const after = await call("GET", `/api/todos?tree=all&assignee=${encodeURIComponent(AGENT)}`);
  assert.equal(after.data.todos.find((t) => t.id === job.id).status, "needs_review");
  // agents can't approve
  assert.equal((await call("POST", `/api/proposals/${prop.data.proposal.id}/approve`, { as: AGENT })).status, 403);
  const before = (await call("GET", "/api/tree?tree=all")).data.research.findings.length;
  const ok = await call("POST", `/api/proposals/${prop.data.proposal.id}/approve`, { body: { note: "thanks" } });
  assert.equal(ok.status, 200);
  const tree = (await call("GET", "/api/tree?tree=all")).data;
  assert.equal(tree.research.findings.length, before + 1);
  assert.ok(tree.research.todo_done.some((t) => t.id === job.id));
  assert.equal((await call("POST", `/api/proposals/${prop.data.proposal.id}/approve`)).status, 409);
});

test("rejecting a suggestion sends the to-do back to the assignee", async () => {
  const pid = Object.keys(ex.bundle.people)[0];
  const job = (await call("POST", "/api/todos?tree=all", { body: { person: pid, task: "Find the burial record", priority: "medium" } })).data.todo;
  const claimed = await call("POST", `/api/todos/${job.id}/claim`, { as: AGENT });
  assert.equal(claimed.status, 200);
  const batch = { log: [{ person: job.person, question: "q", searched: "Another index", result: "nil" }] };
  const prop = await call("POST", "/api/proposals", { as: AGENT, body: { tree: "all", payload: batch, todo_id: job.id } });
  const r = await call("POST", `/api/proposals/${prop.data.proposal.id}/reject`, { body: { note: "search the images, not the index" } });
  assert.equal(r.status, 200);
  const t = (await call("GET", `/api/todos?tree=all&assignee=${encodeURIComponent(AGENT)}`)).data.todos.find((x) => x.id === job.id);
  assert.equal(t.status, "in_progress");
});

test("every write is audited", async () => {
  const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM changes").first()).n;
  assert.ok(n > 5);
});

test("nightly backup writes a full export to R2", async () => {
  const { runBackup } = await import("../worker/backup.js");
  const r = await runBackup(env, new Date("2026-11-15T03:17:00Z"));
  assert.equal(r.key, "backups/2026-11-15.json");
  const saved = JSON.parse(env.MEDIA.objects.get(r.key).body);
  assert.ok(saved.tables.people.length > 0 && saved.tables.todos.length > 0);
});

test("media is only served if attached to someone you can see", async () => {
  await env.MEDIA.put("photos/secret.jpg", "x");
  assert.equal((await call("GET", "/media/photos/secret.jpg")).status, 404);
});
