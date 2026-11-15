// The data quality review (#31): which items a run plans, how decisions are checked, dry runs that change nothing
// until an editor applies them, version checks against items changed meanwhile, and attribution (agent:data-quality
// on behalf of the editor). The agents are a fake env.AGENTS; the shared logic runs directly.
// Fictional example family only.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEnv, client, migrate } from "./helpers/fake-env.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "owner@example.test", EDITOR = "editor@example.test", MEMBER = "member@example.test";
let env, call, calls, Q, Bundle;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ft-dq-"));
  execFileSync("python3", ["tools/build.py", "--data", "example", "--out", dir, "--raw-out", join(dir, "raw.json")], { cwd: ROOT });
  const research = JSON.parse(readFileSync(join(ROOT, "example/research.json"), "utf8"));
  research.trees = [{ id: "all", name: "Everyone", definition: { branches: ["*"] } }];
  writeFileSync(join(dir, "research.json"), JSON.stringify(research));
  execFileSync("python3", ["tools/seed_app.py", "--raw", join(dir, "raw.json"), "--bundle", join(dir, "family.json"), "--research", join(dir, "research.json"), "--out", join(dir, "seed.sql"), "--owner", OWNER, "--cutover"], { cwd: ROOT });
  calls = [];
  env = makeEnv({ AGENTS: { fetch: async (req) => { calls.push({ url: new URL(req.url).pathname, body: req.method === "POST" ? await req.json().catch(() => null) : null }); return new Response("{}", { status: 202 }); } } });
  migrate(env.DB, ROOT);
  env.DB.execFile(join(dir, "seed.sql"));
  call = client((await import("../worker/index.js")).default, env);
  await call("PUT", "/api/admin/grants", { body: { principal: EDITOR, tree_id: "all", role: "editor" } });
  await call("PUT", "/api/admin/grants", { body: { principal: MEMBER, tree_id: "all", role: "member" } });
  Q = await import("../worker/agent/quality.js");
  Bundle = await import("../worker/bundle.js");
});

const start = (body, as = EDITOR) => call("POST", "/api/agent/runs", { as, body: { tree: "all", kind: "quality", ...body } });
const runRow = (id) => env.DB.prepare("SELECT * FROM agent_runs WHERE id = ?").bind(id).first();
const scopeOf = async () => Bundle.scopedFor(env, EDITOR, "all");
const decide = async (id, input) => {
  const run = await runRow(id), sc = await scopeOf();
  const r = await Q.checkDecision(env, sc, run, input);
  if (!r.ok) return r;
  return { ok: true, out: await Q.recordDecision(env, run, r.decision) };
};
const todo = (id) => env.DB.prepare("SELECT * FROM todos WHERE id = ?").bind(id).first();
const finding = async (id) => { const r = await env.DB.prepare("SELECT * FROM findings WHERE id = ?").bind(id).first(); return { ...r, data: JSON.parse(r.data) }; };
const finish = (id) => env.DB.prepare("UPDATE agent_runs SET status = 'succeeded', finished_at = 'x' WHERE id = ?").bind(id).run();

test("editors start reviews; the plan follows scope, person and limit; dry run by default", async () => {
  assert.equal((await start({}, MEMBER)).status, 403);
  let r = await start({ scope: "todos", limit: 1 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.run.kind, "quality");
  assert.equal(r.data.run.options.dry_run, true);
  assert.equal(r.data.run.options.count, 1);
  const sent = calls.at(-1);
  assert.equal(sent.url, `/agents/quality/${r.data.run.id}`);
  assert.match(sent.body.body, /todo:\d+/);
  assert.doesNotMatch(sent.body.body, /finding:/);
  assert.match(sent.body.body, /dry run/);

  r = await start({ scope: "findings", limit: 100 });
  const items = JSON.parse((await runRow(r.data.run.id)).options).items;
  assert.ok(items.length >= 2 && items.every((x) => x.type === "finding"));
  const pid = items[0].person;
  r = await start({ person: pid });
  assert.ok(JSON.parse((await runRow(r.data.run.id)).options).items.every((x) => x.person === pid));
  assert.equal((await start({ person: "I999999" })).status, 404);
});

test("decisions are checked against the run's plan", async () => {
  const { data } = await start({ scope: "both", limit: 100 });
  const items = JSON.parse((await runRow(data.run.id)).options).items;
  let r = await decide(data.run.id, { item: "todo:999999", verdict: "resolved", note: "x" });
  assert.equal(r.ok, false);
  r = await decide(data.run.id, { item: items[0].ref, verdict: "resolved", note: "Answered" });
  assert.match(r.errors.join(), /evidence/);
  r = await decide(data.run.id, { item: items[0].ref, verdict: "duplicate", note: "same" });
  assert.match(r.errors.join(), /duplicate_of/);
  r = await decide(data.run.id, { item: items[0].ref, verdict: "still_valid", note: "n", fix: { reason: "r", ops: [{ op: "person.delete", id: items[0].person }] } });
  assert.match(r.errors.join(), /fix:/);
});

test("a dry run changes nothing until an editor applies it; then it's logged as the agent on their behalf", async () => {
  const { data } = await start({ scope: "both", limit: 100 });
  const id = data.run.id;
  const items = JSON.parse((await runRow(id)).options).items;
  const t = items.find((x) => x.type === "todo"), f = items.find((x) => x.type === "finding");
  const before = { todo: await todo(t.id), finding: await finding(f.id) };
  let r = await decide(id, { item: t.ref, verdict: "resolved", note: "The tree now records it.", evidence: [`${t.person} e1`] });
  assert.equal(r.out.status, "would");
  assert.equal(r.out.detail, "close as done");
  r = await decide(id, { item: f.ref, verdict: "obsolete", note: "The fact it questions was corrected." });
  assert.equal(r.out.status, "would");
  const again = await decide(id, { item: t.ref, verdict: "still_valid", note: "replay" });
  assert.equal(again.out.verdict, "resolved", "one decision per item; a replay returns the first");
  assert.deepEqual(await todo(t.id), before.todo);
  assert.deepEqual((await finding(f.id)).data, before.finding.data);

  assert.equal((await call("POST", `/api/agent/runs/${id}/apply`, { as: EDITOR })).status, 409, "not until it finishes");
  await finish(id);
  assert.equal((await call("POST", `/api/agent/runs/${id}/apply`, { as: MEMBER })).status, 403);
  const ap = await call("POST", `/api/agent/runs/${id}/apply`, { as: OWNER });
  assert.equal(ap.status, 200, JSON.stringify(ap.data));
  assert.deepEqual(ap.data.report.map((d) => d.status), ["applied", "applied"]);
  const td = await todo(t.id);
  assert.equal(td.status, "done");
  assert.match(td.outcome, /The tree now records it/);
  const ev = (await env.DB.prepare("SELECT actor, kind, data FROM todo_events WHERE todo_id = ? ORDER BY id DESC LIMIT 2").bind(t.id).all()).results;
  assert.ok(ev.every((e) => e.actor === "agent:data-quality" && JSON.parse(e.data).on_behalf_of === OWNER), "on behalf of the editor who applied it");
  const fd = await finding(f.id);
  assert.deepEqual([fd.data.resolution.status, fd.data.resolution.by, fd.data.resolution.on_behalf_of], ["dismissed", "agent:data-quality", OWNER]);
  const ch = await env.DB.prepare("SELECT actor, actor_kind, on_behalf_of, via FROM changes WHERE entity_type = 'finding' AND entity_id = ? ORDER BY id DESC").bind(String(f.id)).first();
  assert.deepEqual([ch.actor, ch.actor_kind, ch.on_behalf_of, ch.via], ["agent:data-quality", "agent", OWNER, id]);
  assert.equal((await call("POST", `/api/agent/runs/${id}/apply`, { as: OWNER })).status, 409, "only once");
});

test("outside a dry run decisions apply at once; items changed meanwhile are skipped; fixes become suggestions", async () => {
  const { data } = await start({ scope: "both", limit: 100, dry_run: false });
  assert.equal(data.run.options.dry_run, false);
  const id = data.run.id;
  const items = JSON.parse((await runRow(id)).options).items;
  const f = items.find((x) => x.type === "finding"), t = items.find((x) => x.type === "todo");
  // someone edits the to-do after the run planned it
  const cur = await todo(t.id);
  assert.equal((await call("PATCH", `/api/todos/${t.id}`, { as: OWNER, body: { tree: "all", version: cur.version, priority: cur.priority === "high" ? "low" : "high" } })).status, 200);
  let r = await decide(id, { item: t.ref, verdict: "obsolete", note: "No longer applies." });
  assert.equal(r.out.status, "skipped");
  assert.notEqual((await todo(t.id)).status, "wont_do");

  const sc = await scopeOf();
  const person = sc.bundle.people[f.person];
  const fid = person.events[0].fid;
  r = await decide(id, { item: f.ref, verdict: "resolved", note: "Answered by the birth record.", evidence: [`${f.person} ${fid}`],
    fix: { reason: "The note repeats the date in the wrong format", ops: [{ op: "event.update", entity: "person", id: f.person, fid, set: { note: "Example corrected note" } }] },
    new_todos: [{ task: "Example follow-up", person: f.person, priority: "low" }] });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.out.status, "applied");
  assert.equal((await finding(f.id)).data.resolution.status, "resolved");
  const prop = await env.DB.prepare("SELECT * FROM proposals WHERE id = ?").bind(r.out.proposal).first();
  assert.deepEqual([prop.kind, prop.status, prop.author], ["edit", "open", "agent:data-quality"], "a fix is only ever a suggestion");
  assert.notEqual((await scopeOf()).bundle.people[f.person].events[0].note, "Example corrected note");
  assert.ok(await env.DB.prepare("SELECT 1 FROM todos WHERE task = 'Example follow-up' AND created_by = 'agent:data-quality'").first());
  await finish(id);
  assert.equal((await call("POST", `/api/agent/runs/${id}/apply`, { as: EDITOR })).status, 409, "nothing waits in a live run");
});

test("runs list shows the review with its report", async () => {
  const r = await call("GET", "/api/agent/runs?tree=all", { as: EDITOR });
  const q = r.data.runs.find((x) => x.kind === "quality" && x.report && x.report.length);
  assert.ok(q);
  assert.equal(q.options.items, undefined, "the plan stays server-side");
  assert.ok(q.report[0].verdict);
});
