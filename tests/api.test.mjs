// End-to-end tests of the Worker against the fictional example family, on an in-memory SQLite "D1".
//   npm test        (needs python3 for the example build)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEnv, client, migrate } from "./helpers/fake-env.mjs";

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
  migrate(env.DB, ROOT);
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

test("media is only served if attached to someone you can see", async () => {
  await env.MEDIA.put("photos/secret.jpg", "x");
  assert.equal((await call("GET", "/media/photos/secret.jpg")).status, 404);
});

test("approving a suggestion written before a merge follows the merge; items about removed people can be left out", async () => {
  // a person who'll be removed before the suggestion is approved
  const made = await call("POST", "/api/edit", { body: { tree: "all", reason: "test", ops: [{ op: "person.create", id: "$x", names: [{ given: "Example", surname: "Removed" }] }] } });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const gone = made.data.created.$x;
  const src = [{ title: "Exampleton parish register", url: "https://records.example.org/1" }];
  const batch = {
    findings: [{ person: "I15", kind: "confirmed", confidence: "medium", finding: "Baptism entry matches.", sources: src },
      { person: gone, kind: "confirmed", confidence: "low", finding: "About someone who will be removed.", sources: src }],
    log: [{ person: "I15", question: "baptism", searched: "Exampleton parish register", result: "found" },
      { person: gone, question: "birth", searched: "Exampleton parish register", result: "nil" }],
  };
  const prop = await call("POST", "/api/proposals", { as: AGENT, body: { tree: "all", payload: batch, rationale: "before the merge" } });
  assert.equal(prop.status, 201, JSON.stringify(prop.data));
  // the duplicate is merged and the other person removed after the suggestion was written
  const ed = await call("POST", "/api/edit", { body: { tree: "all", reason: "duplicate", ops: [{ op: "person.merge", keep: "I9", drop: "I15" }, { op: "person.delete", id: gone }] } });
  assert.equal(ed.status, 200, JSON.stringify(ed.data));

  const first = await call("POST", `/api/proposals/${prop.data.proposal.id}/approve`, { body: {} });
  assert.equal(first.status, 422);
  assert.deepEqual(first.data.missing, [gone], "names who's missing; the merged person isn't counted");
  assert.equal(first.data.dropped, 2);
  assert.equal(first.data.can_skip, true);
  assert.match(first.data.error, /2 items are about a person no longer in the tree/);

  const ok = await call("POST", `/api/proposals/${prop.data.proposal.id}/approve`, { body: { skip_missing: true } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const R = (await call("GET", "/api/tree?tree=all")).data.research;
  assert.ok(R.findings.some((f) => f.person === "I9" && f.finding === "Baptism entry matches."), "the finding moved to the kept person");
  assert.ok(!R.findings.some((f) => f.person === gone), "nothing about the removed person");
});

test("names-only grants keep a living person's queue, discussion, and history private", async () => {
  const living = Object.values(ex.bundle.people).find((p) => p.living);
  const member = "limited@example.test";
  await call("PUT", "/api/admin/views/limited", { body: { name: "Names only, research visible", filter: { living: "names-only" } } });
  await call("PUT", "/api/admin/grants", { body: { principal: member, tree_id: "all", role: "member", view_id: "limited" } });
  const todo = (await call("POST", "/api/todos", { body: { person: living.id, task: "Example private task" } })).data.todo;
  await call("POST", "/api/comments", { body: { id: living.id, body: "Example private discussion" } });
  const list = await call("GET", "/api/todos?tree=all", { as: member });
  assert.ok(!list.data.todos.some((t) => t.id === todo.id));
  assert.equal((await call("GET", `/api/todos/${todo.id}/events?tree=all`, { as: member })).status, 404);
  assert.equal((await call("GET", `/api/comments?id=${living.id}&tree=all`, { as: member })).status, 404);
  assert.equal((await call("GET", `/api/history?id=${living.id}&tree=all`, { as: member })).status, 404);
});

test("selected tree limits to-do and undo operations even with grants to another tree", async () => {
  const editor = "branch-editor@example.test";
  await call("PUT", "/api/admin/grants", { body: { principal: editor, tree_id: "one", role: "editor" } });
  await call("PUT", "/api/admin/grants", { body: { principal: editor, tree_id: "all", role: "member" } });
  const todo = (await call("POST", "/api/todos", { body: { tree: "all", task: "Example whole-tree task" } })).data.todo;
  assert.equal((await call("POST", `/api/todos/${todo.id}/claim?tree=one`, { as: editor })).status, 404);
  assert.equal((await call("POST", "/api/proposals?tree=one", { as: editor, body: { payload: { todo_done: [{ id: todo.id }] } } })).status, 404);

  const one = (await call("GET", "/api/tree?tree=one", { as: editor })).data.people;
  const outside = Object.keys(ex.bundle.people).find((id) => !Object.hasOwn(one, id));
  const result = await call("POST", "/api/edit", { body: { reason: "Example edit", ops: [{ op: "person.update", id: outside, set: { notes: ["Example"] } }] } });
  assert.equal(result.status, 200);
  assert.equal((await call("POST", `/api/changes/${result.data.batch}/revert?tree=one`, { as: editor })).status, 404);
  assert.equal((await call("POST", `/api/changes/${result.data.batch}/revert?tree=all`)).status, 200);
});

test("concurrent claims and approvals commit one transition and one set of side effects", async () => {
  const todo = (await call("POST", "/api/todos", { body: { task: "Example concurrent task" } })).data.todo;
  const claims = await Promise.all([OWNER, AGENT].map((as) => call("POST", `/api/todos/${todo.id}/claim?tree=all`, { as })));
  assert.deepEqual(claims.map((r) => r.status).sort(), [200, 409]);
  const log = await call("GET", `/api/todos/${todo.id}/events?tree=all`);
  assert.equal(log.data.events.filter((row) => row.kind === "assigned").length, 1);

  const entry = "Example single submission";
  const proposal = (await call("POST", "/api/proposals", { as: AGENT, body: { tree: "all", payload: { log: [{ searched: entry, result: "nil" }] } } })).data.proposal;
  const decisions = await Promise.all([0, 1].map(() => call("POST", `/api/proposals/${proposal.id}/approve?tree=all`, { body: {} })));
  assert.deepEqual(decisions.map((r) => r.status).sort(), [200, 409]);
  const state = (await call("GET", "/api/tree?tree=all")).data;
  assert.equal(state.research.research_log.filter((row) => row.searched === entry).length, 1);
});

test("legacy media uses the selected tree and cannot serve active content inline", async () => {
  const one = (await call("GET", "/api/tree?tree=one")).data.people;
  const outside = Object.keys(ex.bundle.people).find((id) => !Object.hasOwn(one, id));
  const file = "qa-example/archive.bin";
  const edit = await call("POST", "/api/edit", { body: { reason: "Fictional archival media", ops: [{ op: "media.attach", person: outside, file }] } });
  assert.equal(edit.status, 200);
  await env.MEDIA.put(file, "Example archival bytes", { httpMetadata: { contentType: "text/html" } });
  const read = (tree) => worker.fetch(new Request(`https://tree.example.test/media/${file}?tree=${tree}`), env, {});
  assert.equal((await read("one")).status, 404);
  const allowed = await read("all");
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("Content-Type"), "application/octet-stream");
  assert.equal(allowed.headers.get("Content-Disposition"), "attachment");
  assert.equal(allowed.headers.get("Cache-Control"), "private, no-store");
});

test("browser writes require the app origin and malformed research is rejected", async () => {
  const foreign = await worker.fetch(new Request("https://tree.example.test/api/todos", {
    method: "POST", headers: { Origin: "https://other.example.test" }, body: JSON.stringify({ task: "Example task" }),
  }), env, {});
  assert.equal(foreign.status, 403);
  assert.equal((await call("POST", "/api/proposals", { body: { payload: { findings: [null] } } })).status, 422);
  assert.equal((await call("PUT", "/api/admin/views/invalid-qa", { body: { name: "Invalid", filter: { media: "false" } } })).status, 400);
});

test("a personal home link cannot move the boundary of a generation-limited view", async () => {
  const viewer = "rooted@example.test";
  const home = ex.bundle.home;
  const elsewhere = Object.keys(ex.bundle.people).find((id) => id !== home && !ex.bundle.people[id].fams.length);
  await call("PUT", "/api/admin/trees/qa-root", { body: { name: "Fixed root", definition: { root: home } } });
  await call("PUT", "/api/admin/views/qa-root", { body: { name: "Root household", filter: { max_generations: 0 } } });
  await call("PUT", "/api/admin/grants", { body: { principal: viewer, tree_id: "qa-root", role: "member", view_id: "qa-root" } });
  await call("PUT", "/api/admin/grants", { body: { principal: viewer, tree_id: "all", role: "member" } });
  const before = (await call("GET", "/api/tree?tree=qa-root", { as: viewer })).data.people;
  assert.ok(!Object.hasOwn(before, elsewhere));
  assert.equal((await call("PUT", "/api/me/person", { as: viewer, body: { tree: "all", person_id: elsewhere } })).status, 200);
  assert.deepEqual(Object.keys((await call("GET", "/api/tree?tree=qa-root", { as: viewer })).data.people), Object.keys(before));
});

test("a service identity never inherits editor or owner authority", async () => {
  await call("PUT", "/api/admin/grants", { body: { principal: AGENT, tree_id: "all", role: "editor" } });
  const me = await call("GET", "/api/me", { as: AGENT });
  assert.equal(me.data.kind, "agent");
  assert.equal(me.data.trees[0].role, "agent");
  assert.equal((await call("GET", "/api/export.ged?tree=all", { as: AGENT })).status, 403);
  await call("PUT", "/api/admin/grants", { body: { principal: AGENT, tree_id: "all", role: "agent" } });
});

test("Access authentication requires signed tokens with a future expiration", async () => {
  const { identify } = await import("../worker/auth.js");
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1) }, true, ["sign", "verify"]);
  const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const fetchBefore = globalThis.fetch;
  const team = "access-test.example.test", aud = "example-audience";
  globalThis.fetch = async () => Response.json({ keys: [{ ...publicKey, kid: "example-key" }] });
  try {
    async function authenticate(exp) {
      const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "example-key" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ exp, iss: `https://${team}`, aud, email: MEMBER })).toString("base64url");
      const signed = `${header}.${payload}`;
      const sig = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, Buffer.from(signed))).toString("base64url");
      const request = new Request("https://tree.example.test/api/me", { headers: { "Cf-Access-Jwt-Assertion": `${signed}.${sig}` } });
      return identify(request, { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud });
    }
    const now = Math.floor(Date.now() / 1000);
    assert.equal((await authenticate(now + 60)).ok, true);
    assert.equal((await authenticate(now - 1)).ok, false);
    assert.equal((await authenticate(undefined)).ok, false);
  } finally { globalThis.fetch = fetchBefore; }
});
