// Cloud research agents and AI content, site side: who may start runs, what reaches the agent, how submissions are
// checked and filed, and how AI profiles and story revisions flow. The agents themselves (Flue) are replaced by a
// fake env.AGENTS; the shared logic it calls is exercised directly. Fictional example family only.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEnv, client, migrate } from "./helpers/fake-env.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "owner@example.test", EDITOR = "editor@example.test", NARROW = "narrow@example.test", MEMBER = "member@example.test";
// an editor whose view reduces living people to their names: for them, the living are private
const NAMES = "names@example.test";
let env, call, ex, calls, branchKey;
let Tools, Runs, Content, Bundle;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ft-ag-"));
  execFileSync("python3", ["tools/build.py", "--data", "example", "--out", dir, "--raw-out", join(dir, "raw.json")], { cwd: ROOT });
  const research = JSON.parse(readFileSync(join(ROOT, "example/research.json"), "utf8"));
  branchKey = research.branches[0].key;
  research.trees = [{ id: "all", name: "Everyone", definition: { branches: ["*"] } }, { id: "one", name: "One branch", definition: { branches: [branchKey] } }];
  writeFileSync(join(dir, "research.json"), JSON.stringify(research));
  execFileSync("python3", ["tools/seed_app.py", "--raw", join(dir, "raw.json"), "--bundle", join(dir, "family.json"), "--research", join(dir, "research.json"), "--out", join(dir, "seed.sql"), "--owner", OWNER, "--cutover"], { cwd: ROOT });
  calls = [];
  env = makeEnv({
    AGENTS: { fetch: async (req) => { calls.push({ url: new URL(req.url).pathname, method: req.method, body: req.method === "POST" ? await req.json().catch(() => null) : null }); return new Response(JSON.stringify({ ok: true }), { status: 202 }); } },
    AGENT_MAX_RUNS_PER_DAY: "5",
  });
  migrate(env.DB, ROOT);
  env.DB.execFile(join(dir, "seed.sql"));
  call = client((await import("../worker/index.js")).default, env);
  ex = JSON.parse(readFileSync(join(dir, "family.json"), "utf8"));
  await call("PUT", "/api/admin/grants", { body: { principal: EDITOR, tree_id: "all", role: "editor" } });
  await call("PUT", "/api/admin/grants", { body: { principal: NARROW, tree_id: "one", role: "editor" } });
  await call("PUT", "/api/admin/grants", { body: { principal: MEMBER, tree_id: "all", role: "member" } });
  await call("PUT", "/api/admin/views/names", { body: { name: "Names only", filter: { living: "names-only" } } });
  await call("PUT", "/api/admin/grants", { body: { principal: NAMES, tree_id: "all", role: "editor", view_id: "names" } });
  Tools = await import("../worker/agent/tools.js");
  Runs = await import("../worker/agent/runs.js");
  Content = await import("../worker/agent/content.js");
  Bundle = await import("../worker/bundle.js");
});

const dead = () => Object.values(ex.people).find((p) => !p.living && p.events.length >= 2 && p.branch === branchKey);
const living = () => Object.values(ex.people).find((p) => p.living);
const lastCall = () => calls[calls.length - 1];

test("/api/me says whether agents are available", async () => {
  assert.equal((await call("GET", "/api/me")).data.ai, true);
  const off = makeEnv(); // no AGENTS binding
  migrate(off.DB, ROOT);
  const c2 = client((await import("../worker/index.js")).default, off);
  assert.equal((await c2("GET", "/api/me")).data.ai, false);
});

test("only editors start runs; living relatives are researched unless private in the starter's view", async () => {
  const p = dead();
  assert.equal((await call("POST", "/api/agent/runs", { as: MEMBER, body: { tree: "all", person: p.id } })).status, 403);
  assert.equal((await call("GET", "/api/agent/runs?tree=all", { as: MEMBER })).status, 403);
  const lv = living();
  assert.ok(lv, "the example family has living people");
  const refused = await call("POST", "/api/agent/runs", { as: NAMES, body: { tree: "all", person: lv.id } });
  assert.equal(refused.status, 400, "private in the starter's view");
  assert.match(refused.data.error, /private in your view/);
  const ok = await call("POST", "/api/agent/runs", { as: EDITOR, body: { tree: "all", person: lv.id } });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.match(lastCall().body.body, new RegExp(`get_person\\("${lv.id}"\\)`));
  assert.equal((await call("POST", "/api/agent/runs", { as: EDITOR, body: { tree: "all" } })).status, 400, "needs a to-do, a person or instructions");
});

test("starting a run claims the to-do and hands the agent its task through env.AGENTS", async () => {
  const p = dead();
  const td = (await call("POST", "/api/todos", { as: EDITOR, body: { tree: "all", person: p.id, task: "Find the burial record", where: "Parish registers" } })).data.todo;
  const r = await call("POST", "/api/agent/runs", { as: EDITOR, body: { tree: "all", todo_id: td.id, instructions: "Prefer original registers." } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const run = r.data.run;
  assert.match(run.id, /^run-\d{8}-[0-9a-f]{8}$/);
  assert.equal(run.status, "queued");
  const sent = lastCall();
  assert.equal(sent.url, `/agents/researcher/${run.id}`);
  assert.deepEqual(sent.body.initialData, { runId: run.id });
  assert.equal(sent.body.kind, "user");
  assert.match(sent.body.body, /Find the burial record/);
  assert.match(sent.body.body, /Prefer original registers/);
  assert.match(sent.body.body, new RegExp(`get_person\\("${p.id}"\\)`));
  const todo = (await call("GET", `/api/todos?tree=all&person=${p.id}`, { as: EDITOR })).data.todos.find((t) => t.id === td.id);
  assert.equal(todo.assignee, Runs.AGENT);
  assert.equal(todo.status, "in_progress");
  // a second run on the same to-do is refused while the first holds it
  assert.equal((await call("POST", "/api/agent/runs", { as: EDITOR, body: { tree: "all", todo_id: td.id } })).status, 409);
  // cancelling aborts the agent conversation and gives the to-do back
  const cx = await call("POST", `/api/agent/runs/${run.id}/cancel`, { as: EDITOR });
  assert.equal(cx.status, 200, JSON.stringify(cx.data));
  assert.equal(lastCall().url, `/agents/researcher/${run.id}/abort`);
  const after = (await call("GET", `/api/todos?tree=all&person=${p.id}`, { as: EDITOR })).data.todos.find((t) => t.id === td.id);
  assert.equal(after.assignee, null);
  assert.equal(after.status, "open");
  assert.equal((await call("GET", `/api/agent/runs/${run.id}`, { as: EDITOR })).data.run.status, "cancelled");
});

test("the agent sees only its starter's scope; living relatives in full, unless the view keeps them private", async () => {
  const b = (await Bundle.scopedFor(env, NARROW, "one")).bundle;
  const outside = Object.values(ex.people).find((p) => p.branch !== branchKey && !p.living);
  if (outside) assert.ok(Tools.personView(b, outside.id).error, "people outside the starter's tree are invisible");
  const lv = Object.values(ex.people).find((p) => p.living && p.events.length >= 2);
  assert.ok(lv, "a living person with recorded events");
  // a view that reduces the living to names: a name and family only
  const priv = Tools.personView((await Bundle.scopedFor(env, NAMES, "all")).bundle, lv.id);
  assert.deepEqual(Object.keys(priv).sort(), ["family", "id", "name", "note", "private"]);
  assert.ok(!JSON.stringify(priv).includes("events"));
  assert.ok(!JSON.stringify(priv).includes(String(lv.birth.year)), "no dates for a private person");
  // a full view: the living relative's recorded facts, marked living
  const full = Tools.personView((await Bundle.scopedFor(env, EDITOR, "all")).bundle, lv.id);
  assert.equal(full.living, true);
  assert.equal(full.private, undefined);
  assert.equal(full.events.length, lv.events.length);
  const p = dead();
  const v = Tools.personView(b, p.id);
  assert.equal(v.id, p.id);
  assert.ok(v.events.length >= 2);
  assert.ok(Tools.searchPeople(b, p.name.split(" ")[0]).matches.some((m) => m.id === p.id));
});

test("submissions are checked before anything is filed", async () => {
  const b = (await Bundle.scopedFor(env, EDITOR, "all")).bundle;
  const p = dead(), lv = living();
  const good = { summary: "Searched the parish registers.", batch: {
    findings: [{ person: p.id, kind: "confirmed", finding: "Burial register entry matches.", confidence: "medium", sources: [{ title: "Parish burial register", note: "Index entry only; image not viewed" }] }],
    log: [{ person: p.id, searched: "FreeREG burials, surname and county", result: "found" }] } };
  assert.equal((await Tools.checkSubmission(env, b, good)).ok, true);
  const bad = async (x) => (await Tools.checkSubmission(env, b, x)).errors.join(" | ");
  assert.match(await bad({ summary: "x", batch: { findings: [{ ...good.batch.findings[0], sources: [] }], log: good.batch.log } }), /no sources/);
  assert.match(await bad({ summary: "x", batch: { findings: good.batch.findings } }), /log every search/);
  assert.match(await bad({ summary: "" }), /summary/);
  assert.match(await bad({ summary: "x", batch: { log: good.batch.log }, edits: { reason: "dup", sources: [{ title: "t", note: "n" }], ops: [{ op: "person.delete", id: p.id }] } }), /never delete people/);
  // a finding about a living relative is fine in a full view, refused where the starter's view keeps them private
  const onLiving = { summary: "x", batch: { findings: [{ ...good.batch.findings[0], person: lv.id }], log: [{ ...good.batch.log[0], person: lv.id }] } };
  assert.equal((await Tools.checkSubmission(env, b, onLiving)).ok, true, "living relatives are researched");
  const nb = (await Bundle.scopedFor(env, NAMES, "all")).bundle;
  const r = await Tools.checkSubmission(env, nb, onLiving);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" | "), new RegExp(lv.id));
  const edit = { summary: "x", batch: { log: good.batch.log }, edits: { reason: "A record gives the birth date.", sources: [{ title: "t", note: "n" }], ops: [{ op: "event.add", entity: "person", id: lv.id, event: { type: "Residence", date: "2001" } }] } };
  assert.match((await Tools.checkSubmission(env, nb, edit)).errors.join(" | "), /private in this tree's view/);
  const fullEdit = await Tools.checkSubmission(env, b, edit);
  assert.equal(fullEdit.ok, true, JSON.stringify(fullEdit.errors));
  assert.match(await bad({ summary: "x", batch: { log: good.batch.log, people_status: { [p.id]: { status: "partly-verified", note: "n" } } } }), /status change needs/);
  assert.equal((await Tools.checkSubmission(env, b, { ...good, batch: { ...good.batch, people_status: { [p.id]: { status: "partly-verified", note: "n" } } } })).ok, true);
});

test("a valid submission becomes suggestions for review; filing is idempotent", async () => {
  const p = dead();
  const td = (await call("POST", "/api/todos", { as: EDITOR, body: { tree: "all", person: p.id, task: "Confirm the death date" } })).data.todo;
  const run = (await call("POST", "/api/agent/runs", { as: EDITOR, body: { tree: "all", todo_id: td.id } })).data.run;
  await Runs.markRunning(env, run.id);
  const b = (await Bundle.scopedFor(env, EDITOR, "all")).bundle;
  const sub = await Tools.checkSubmission(env, b, { summary: "Found the death index entry.", batch: {
    findings: [{ person: p.id, kind: "confirmed", field: "death", finding: "Death index entry agrees with the tree.", confidence: "high", sources: [{ title: "Death index (example)", url: "https://example.org/record/1" }] }],
    log: [{ person: p.id, searched: "Death index, name and year range", result: "found" }] } });
  assert.equal(sub.ok, true, JSON.stringify(sub.errors));
  const first = await Runs.submitResults(env, run.id, sub.value);
  const again = await Runs.submitResults(env, run.id, sub.value);
  assert.equal(first.proposals.length, 1);
  assert.deepEqual(again.proposals, first.proposals);
  const props = (await call("GET", "/api/proposals?tree=all", { as: EDITOR })).data.proposals.filter((x) => x.author === Runs.AGENT);
  assert.equal(props.length, 1);
  assert.equal(props[0].todo_id, td.id);
  assert.match(props[0].rationale, new RegExp(run.id));
  const todo = (await call("GET", `/api/todos?tree=all&person=${p.id}`, { as: EDITOR })).data.todos.find((t) => t.id === td.id);
  assert.equal(todo.status, "needs_review");
  // the editor approves it like any suggestion: the finding lands and the to-do closes
  const ok = await call("POST", `/api/proposals/${props[0].id}/approve`, { as: EDITOR, body: {} });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const tree = (await call("GET", "/api/tree?tree=all", { as: EDITOR })).data;
  assert.ok(tree.research.findings.some((f) => f.finding === "Death index entry agrees with the tree."));
  assert.equal((await call("GET", `/api/agent/runs/${run.id}`, { as: EDITOR })).data.run.status, "succeeded");
});

test("a run that ends without results releases its to-do", async () => {
  const p = dead();
  const td = (await call("POST", "/api/todos", { as: EDITOR, body: { tree: "all", person: p.id, task: "Look for a will" } })).data.todo;
  const run = (await call("POST", "/api/agent/runs", { as: EDITOR, body: { tree: "all", todo_id: td.id } })).data.run;
  await Runs.endRun(env, run.id, "The agent finished without submitting results.");
  const todo = (await call("GET", `/api/todos?tree=all&person=${p.id}`, { as: EDITOR })).data.todos.find((t) => t.id === td.id);
  assert.equal(todo.status, "open");
  assert.equal(todo.assignee, null);
  const events = (await call("GET", `/api/todos/${td.id}/events`, { as: EDITOR })).data.events;
  assert.ok(events.some((e) => e.kind === "comment" && /without submitting/.test(e.data.text)));
});

test("the daily run limit is enforced", async () => {
  const p = dead();
  let last;
  for (let i = 0; i < 6; i++) last = await call("POST", "/api/agent/runs", { as: EDITOR, body: { tree: "all", person: p.id } });
  assert.equal(last.status, 429);
  assert.match(last.data.error, /daily limit/);
});

test("profiles: written for living relatives too; a living relative is named without dates; private views don't show them", async () => {
  // living relatives get profiles like anyone else, given enough recorded
  const lv = Object.values(ex.people).find((x) => x.living && x.events.length >= 2);
  const lp = await Content.prepareProfile(env, lv.id);
  assert.equal(lp.skipped, undefined, JSON.stringify(lp));
  assert.match(lp.hash, /^[0-9a-f]{64}$/);
  assert.equal(lp.facts.name, lv.name);
  assert.equal(lp.facts.events.length, lv.events.length);
  const thin = Object.values(ex.people).find((x) => x.living && x.events.length < 2 && !(x.notes || []).length);
  if (thin) assert.match((await Content.prepareProfile(env, thin.id)).skipped, /not enough/);

  // as someone else's relative, a living person appears by name, marked living, with no dates
  const withLivingKin = Object.values(ex.people).find((p) => !p.living && p.events.length >= 2 && [...(p.fams || [])].some((f) => (ex.families[f].children || []).some((c) => ex.people[c].living)));
  assert.ok(withLivingKin, "the example family has someone with a living child");
  const p = withLivingKin;
  const prep = await Content.prepareProfile(env, p.id);
  assert.match(prep.hash, /^[0-9a-f]{64}$/);
  assert.equal(prep.current, false);
  const kids = p.fams.flatMap((f) => ex.families[f].children || []).map((c) => ex.people[c]).filter((c) => c.living);
  for (const k of kids) {
    const line = prep.facts.family.find((x) => x.includes(k.name));
    assert.match(line, new RegExp(`^(son|daughter|child) ${k.name} \\(living\\)$`), line);
  }
  assert.ok(!prep.facts.family.some((x) => /a living/.test(x)), "no unnamed 'a living …' any more");

  await Content.saveProfile(env, p.id, { text: "A short, factual biography of this person, written from the recorded facts only.", hash: prep.hash, model: "test" });
  await Content.saveProfile(env, lv.id, { text: "A short, factual biography of a living relative, from the recorded facts only.", hash: lp.hash, model: "test" });
  assert.equal((await Content.prepareProfile(env, p.id)).current, true);
  const shown = (await call("GET", "/api/tree?tree=all", { as: EDITOR })).data.people;
  assert.match(shown[p.id].profile.text, /factual biography/);
  assert.match(shown[lv.id].profile.text, /living relative/, "a full view shows a living relative's profile");
  // the plan skips them now
  const plan = await Content.planContent(env, { limit: 500 });
  assert.ok(!plan.some((i) => i.kind === "profile" && (i.id === p.id || i.id === lv.id)));
  // a view that reduces the living to names drops their profiles, and keeps the others
  const names = (await call("GET", "/api/tree?tree=all", { as: NAMES })).data;
  assert.equal(names.people[lv.id].profile, undefined);
  assert.ok(!JSON.stringify(names).includes("living relative, from the recorded facts"));
  assert.match(names.people[p.id].profile.text, /factual biography/);
  // refreshing a profile from a view where they're private is refused
  const rf = await call("POST", `/api/profiles/${lv.id}/refresh?tree=all`, { as: NAMES });
  assert.equal(rf.status, 400);
  assert.match(rf.data.error, /private in your view/);
  // and a view without notes shows no profile at all
  await call("PUT", "/api/admin/views/nonotes", { body: { name: "No notes", filter: { living: "names-only", notes: false } } });
  await call("PUT", "/api/admin/grants", { body: { principal: MEMBER, tree_id: "all", role: "member", view_id: "nonotes" } });
  assert.equal((await call("GET", "/api/tree?tree=all", { as: MEMBER })).data.people[p.id].profile, undefined);
});

test("stories: an out-of-date story becomes a suggested revision; approving it updates the story", async () => {
  const story = ex.research.stories[0];
  const prep = await Content.prepareStory(env, story.slug);
  assert.ok(prep.hash);
  const up = await Content.saveStoryVerdict(env, story.slug, { hash: prep.hash, up_to_date: true, reason: "", title: story.title, body: story.body });
  assert.equal(up.up_to_date, true);
  assert.ok(!(await Content.planContent(env, { limit: 500 })).some((i) => i.kind === "story" && i.id === story.slug), "checked stories leave the plan");
  const body = `${story.body}\n\nThis paragraph was revised after a date changed.`;
  const r = await Content.saveStoryVerdict(env, story.slug, { hash: prep.hash, up_to_date: false, reason: "A date changed.", title: story.title, body });
  assert.ok(r.proposal);
  assert.ok((await Content.prepareStory(env, story.slug)).skipped, "no second revision while one is waiting");
  const ok = await call("POST", `/api/proposals/${r.proposal}/approve`, { as: OWNER, body: {} });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const st = (await call("GET", "/api/tree?tree=all", { as: OWNER })).data.research.stories.find((s) => s.slug === story.slug);
  assert.match(st.body, /revised/);
  assert.ok(st.revised);
});

test("profile refresh and content refresh go to the agents", async () => {
  const p = dead();
  assert.equal((await call("POST", `/api/profiles/${p.id}/refresh?tree=all`, { as: MEMBER })).status, 403);
  const r = await call("POST", `/api/profiles/${p.id}/refresh?tree=all`, { as: EDITOR });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  assert.deepEqual(lastCall().body, { person: p.id, force: true });
  const lv = living();
  assert.equal((await call("POST", `/api/profiles/${lv.id}/refresh?tree=all`, { as: EDITOR })).status, 202, "a living relative's profile, in a full view");
  assert.deepEqual(lastCall().body, { person: lv.id, force: true });
  assert.equal((await call("POST", "/api/content/refresh", { as: EDITOR })).status, 403);
  assert.equal((await call("POST", "/api/content/refresh", { as: OWNER })).status, 202);
  assert.equal(lastCall().url, "/internal/content/refresh");
});
