// The stories librarian (#36): auditing every story against the tree, filing fixes as story revisions (nothing
// published changes until an editor approves), ranking candidate subjects for new stories, and commissioning at most
// N story-writer runs, each linked to the librarian run. The agents Worker is a fake service binding; the shared
// logic runs directly. Fictional example family only.
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
const YEAR = 2026;
let env, call, calls, L, Bundle;

// A fictional story with one claim the tree contradicts (the example tree records Arthur's birth as 1899).
const WRONG = {
  slug: "example-arthur", title: "Example: Arthur's years", era: "1899–1966", people: ["I8"],
  sources: [{ title: "Example family papers", note: "example only" }],
  body: "[[I8|Arthur Hartley]] was born in 1897. He died in 1966.\n\nHe married [[I9|Florence Pike]].",
};

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ft-lib-"));
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
  L = await import("../worker/agent/library.js");
  Bundle = await import("../worker/bundle.js");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO stories (slug, data, updated_at, updated_by) VALUES (?, ?, 'x', ?)").bind(WRONG.slug, JSON.stringify(WRONG), OWNER),
    env.DB.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'data_version'"),
  ]);
});

const b = async () => (await Bundle.scopedFor(env, EDITOR, "all")).bundle;
const start = (body, as = EDITOR) => call("POST", "/api/agent/runs", { as, body: { tree: "all", kind: "library", ...body } });
const runRow = (id) => env.DB.prepare("SELECT * FROM agent_runs WHERE id = ?").bind(id).first();
const story = async (slug) => (await call("GET", "/api/tree?tree=all", { as: EDITOR })).data.research.stories.find((x) => x.slug === slug);
const fakeStory = (body, people = []) => ({ slug: "t", title: "T", people, body });

test("the audit flags contradicted and unrecorded claims, gone and merged people, and details of the living", async () => {
  const B = await b();
  let f = L.auditStory(B, WRONG);
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.equal(f[0].kind, "contradiction");
  assert.equal(f[0].person, "I8");
  assert.equal(f[0].story_says, 1897);
  assert.match(f[0].tree_says, /1899/);
  assert.match(L.flagText(B, f[0]), /Arthur Hartley \(I8\)/);
  // the subject carries over within a paragraph; "abt" dates allow a couple of years either way
  assert.deepEqual(L.auditStory(B, fakeStory("[[I15|Florence]] was born in 1905. She died in 1979.")), []);
  f = L.auditStory(B, fakeStory("[[I17|Thomas]] died in 1980."));
  assert.deepEqual(f.map((x) => [x.kind, x.type]), [["unsupported", "Death"]]);
  f = L.auditStory(B, fakeStory("Here is [[I999999|Nobody]].", ["I999998"]));
  assert.deepEqual(f.map((x) => x.kind).sort(), ["broken_link", "removed"]);
  f = L.auditStory(B, fakeStory("[[I1|Sam]] was born in 1992."));
  assert.deepEqual(f.map((x) => x.kind), ["living_details"]);
  // a person merged into another is followed, and flagged
  const merged = { ...B, aliases: { I777: "I8" } };
  f = L.auditStory(merged, fakeStory("[[I777|Arthur]] was born in 1899.", ["I777"]));
  assert.deepEqual(f.map((x) => [x.kind, x.into, x.where]), [["merged", "I8", "link"], ["merged", "I8", "people"]]);
  // the example story itself is clean
  assert.deepEqual(L.auditStory(B, B.research.stories.find((s) => s.slug === "eva-comes-to-england")), []);
});

test("candidates: people who have died with sourced records, uncovered first; the possibly living are skipped", async () => {
  const B = await b();
  const c = L.rankCandidates(B, { limit: 50, year: YEAR });
  const ids = c.filter((x) => x.kind === "person").map((x) => x.people[0]);
  for (const id of ["I1", "I2", "I3", "I16"]) assert.ok(!ids.includes(id), `${id} is living`);
  assert.equal(L.couldBeLiving(B.people.I17, YEAR), true, "born 1925, no death recorded");
  assert.equal(L.couldBeLiving(B.people.I11, YEAR), false, "born 1908");
  assert.equal(L.couldBeLiving(B.people.I8, YEAR), false);
  assert.ok(!c.some((x) => x.people.includes("I17")));
  for (const x of c) assert.ok(x.material.sourced || x.material.sources || x.kind === "group");
  // I5 is in the example story, I8 in the test story: covered, so after everyone uncovered
  const i5 = c.find((x) => x.key === "person:I5"), firstCovered = c.findIndex((x) => x.covered_by.length);
  assert.deepEqual(i5.covered_by, ["eva-comes-to-england"]);
  assert.ok(c.slice(0, firstCovered).every((x) => !x.covered_by.length));
  assert.ok(c.slice(firstCovered).every((x) => x.covered_by.length));
  for (let i = 1; i < firstCovered; i++) assert.ok(c[i - 1].score >= c[i].score, "uncovered ones by score");
  assert.ok(c[0].score > 0 && !c[0].covered_by.length);
  // more sourced material ranks higher
  const more = structuredClone(B);
  more.people.I7.events.forEach((e) => { e.citations = [{ source: "S-example-1" }, { source: "S-example-2" }]; });
  assert.equal(L.rankCandidates(more, { limit: 1, year: YEAR })[0].key, "person:I7");
  // an event several people share is a group candidate
  const shared = structuredClone(B);
  shared.people.I12.events.push({ type: "Military", date: "1918", place: shared.people.I8.events.find((e) => e.type === "Military").place, citations: [{ source: "S-example-1" }] });
  const g = L.rankCandidates(shared, { limit: 50, year: YEAR }).find((x) => x.kind === "group");
  assert.ok(g, "a shared war");
  assert.deepEqual(g.people, ["I12", "I8"]);
  assert.match(g.label, /Military · .* · 1910s/);
});

test("editors start library reviews; the plan lists every story with its flags and the candidates", async () => {
  assert.equal((await start({}, MEMBER)).status, 403);
  assert.equal((await start({ n: 9 })).status, 400);
  assert.equal((await start({ n: -1 })).status, 400);
  const r = await start({});
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.run.kind, "library");
  assert.equal(r.data.run.options.n, 2, "N defaults to 2");
  assert.deepEqual(r.data.run.report, { checked: [], children: [] });
  const plan = r.data.run.options;
  assert.equal(plan.stories[0].slug, WRONG.slug, "flagged stories first");
  assert.equal(plan.stories[0].flags[0].kind, "contradiction");
  assert.ok(plan.stories.some((s) => s.slug === "eva-comes-to-england"));
  assert.ok(plan.candidates.length > 0);
  const sent = calls.at(-1);
  assert.equal(sent.url, `/agents/library/${r.data.run.id}`);
  assert.match(sent.body.body, /example-arthur: “Example: Arthur's years”/);
  assert.match(sent.body.body, /the records give birth .*1899 for Arthur Hartley \(I8\)/);
  assert.match(sent.body.body, /Commission up to 2 new stories/);
  assert.match(sent.body.body, /person:I\d+/);
  assert.equal((await call("POST", `/api/agent/runs/${r.data.run.id}/cancel`, { as: EDITOR })).status, 200);
  assert.equal(calls.at(-1).url, `/agents/library/${r.data.run.id}/abort`);
});

test("a contradicted story gets a revision suggestion; nothing published changes until an editor approves", async () => {
  const run = await runRow((await start({ n: 0 })).data.run.id);
  const B = await b();
  // the revision is checked by the story writer's own checks
  let r = L.checkStoryCheck(B, run, { slug: WRONG.slug, verdict: "revised", note: "Birth year.", body: WRONG.body, changes: [{ change: "c", reason: "r" }] });
  assert.match(r.errors.join(), /unchanged/);
  r = L.checkStoryCheck(B, run, { slug: WRONG.slug, verdict: "revised", note: "Birth year.", body: WRONG.body.replace("1897", "1899").replace("[[I9|", "[[I999999|"), changes: [{ change: "c", reason: "r" }] });
  assert.match(r.errors.join(), /isn't in this tree/);
  assert.match(L.checkStoryCheck(B, run, { slug: "no-such", verdict: "up_to_date", note: "n" }).errors.join(), /one of this run's stories/);
  const body = WRONG.body.replace("1897", "1899");
  r = L.checkStoryCheck(B, run, { slug: WRONG.slug, verdict: "revised", note: "The tree records Arthur's birth in 1899, not 1897.", body, changes: [{ change: "Birth year 1897 → 1899", reason: "Contradicted by the birth record", facts: ["I8 e1"] }] });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const out = await L.recordStoryCheck(env, run, r.value);
  assert.ok(out.proposal);
  assert.deepEqual(await L.recordStoryCheck(env, await runRow(run.id), r.value), out, "idempotent per story");
  const prop = await env.DB.prepare("SELECT * FROM proposals WHERE id = ?").bind(out.proposal).first();
  assert.equal(prop.author, "agent:library");
  assert.equal(prop.status, "open");
  const pay = JSON.parse(prop.payload);
  assert.equal(pay.story_updates[0].slug, WRONG.slug);
  assert.equal(pay.story_updates[0].changes[0].facts[0], "I8 e1");
  assert.equal((await story(WRONG.slug)).body, WRONG.body, "nothing changes before approval");

  // other stories get their verdicts; then the run finishes with the revision as its suggestion
  const rest = JSON.parse(run.options).stories.filter((s) => s.slug !== WRONG.slug);
  for (const s of rest) {
    const ok = L.checkStoryCheck(B, await runRow(run.id), { slug: s.slug, verdict: "up_to_date", note: "Checked every claim." });
    await L.recordStoryCheck(env, await runRow(run.id), ok.value);
  }
  await L.finishLibrary(env, await runRow(run.id), "Fixed one birth year.");
  const done = (await call("GET", `/api/agent/runs/${run.id}`, { as: EDITOR })).data.run;
  assert.equal(done.status, "succeeded");
  assert.deepEqual(done.proposals, [out.proposal]);
  assert.equal(done.report.checked.find((c) => c.slug === WRONG.slug).proposal, out.proposal);
  assert.equal(JSON.parse((await runRow(run.id)).result).counts.revised, 1);

  // a second run sees the revision waiting and won't file another
  const again = await runRow((await start({ n: 0 })).data.run.id);
  assert.equal(JSON.parse(again.options).stories.find((s) => s.slug === WRONG.slug).pending, out.proposal);
  assert.match(L.checkStoryCheck(B, again, { slug: WRONG.slug, verdict: "revised", note: "n", body, changes: [{ change: "c", reason: "r" }] }).errors.join(), /already waiting/);

  const ap = await call("POST", `/api/proposals/${out.proposal}/approve`, { as: OWNER, body: { tree: "all" } });
  assert.equal(ap.status, 200, JSON.stringify(ap.data));
  const now = await story(WRONG.slug);
  assert.equal(now.body, body);
  assert.deepEqual(now.sources, WRONG.sources, "the story keeps its citations");
  assert.deepEqual(L.auditStory(await b(), now), [], "the fixed story is clean");
});

test("a run with N = 1 starts exactly one story-writer run, linked from the librarian's report", async () => {
  const lib = (await start({ n: 1 })).data.run;
  let run = await runRow(lib.id);
  const B = await b();
  assert.match(L.checkCommission(B, run, { people: ["I1"], brief: "A story about someone living, which must not happen." }).errors.join(), /could be living/);
  assert.match(L.checkCommission(B, run, { people: ["I17"], brief: "No death recorded and born within living memory." }).errors.join(), /could be living/);
  assert.match(L.checkCommission(B, run, { people: ["I7"], brief: "short" }).errors.join(), /brief/);
  const brief = "Ingrid Lindqvist (I7): her life from birth to death, built on her sourced death record (I7 e2).";
  const c = L.checkCommission(B, run, { people: ["I7"], brief, length: "short", candidate: "person:I7" });
  assert.equal(c.ok, true, JSON.stringify(c.errors));
  const child = await L.commissionStory(env, run, B, c.value);
  assert.match(child.id, /^run-/);
  assert.match(child.message, /Draft a new story about Ingrid Lindqvist \(I7\), about 300 words/);
  assert.match(child.message, /I7 e2/);
  run = await runRow(lib.id);
  // the same subject again is the same child; another subject is over the limit
  const again = L.checkCommission(B, run, { people: ["I7"], brief });
  assert.equal((await L.commissionStory(env, run, B, again.value)).id, child.id);
  assert.match(L.checkCommission(B, run, { people: ["I12"], brief: "Another life, which this run may not start." }).errors.join(), /may start 1 new story/);

  const kids = (await env.DB.prepare("SELECT * FROM agent_runs WHERE kind = 'story' AND json_extract(options, '$.parent') = ?").bind(lib.id).all()).results;
  assert.equal(kids.length, 1, "exactly one story-writer run");
  const k = kids[0];
  assert.equal(k.id, child.id);
  assert.equal(k.status, "queued");
  assert.equal(k.started_by, EDITOR, "the child works as the editor who started the librarian");
  assert.deepEqual(JSON.parse(k.options), { mode: "draft", people: ["I7"], length: "short", instructions: brief, parent: lib.id });
  const out = (await call("GET", `/api/agent/runs/${lib.id}`, { as: EDITOR })).data.run;
  assert.equal(out.report.children.length, 1);
  assert.equal(out.report.children[0].run, child.id);
  assert.deepEqual(out.report.children[0].people, ["I7"]);
  assert.equal(out.report.children[0].message, undefined, "the child's first message stays server-side");
  const listed = (await call("GET", "/api/agent/runs", { as: EDITOR })).data.runs.find((x) => x.id === child.id);
  assert.equal(listed.options.parent, lib.id);
});

test("a commission past today's run budget isn't started", async () => {
  const lib = await runRow((await start({ n: 2 })).data.run.id);
  const B = await b();
  const c = L.checkCommission(B, lib, { people: ["I13"], brief: "Olof Lindqvist (I13): his migration, from his sourced immigration record." });
  await env.DB.prepare("UPDATE ai_usage SET runs = 999 WHERE day = ?").bind(new Date().toISOString().slice(0, 10)).run();
  try {
    const r = await L.commissionStory(env, lib, B, c.value);
    assert.match(r.error, /daily limit/);
    assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE json_extract(options, '$.parent') = ?").bind(lib.id).first()).n, 0);
  } finally {
    await env.DB.prepare("UPDATE ai_usage SET runs = 0 WHERE day = ?").bind(new Date().toISOString().slice(0, 10)).run();
  }
});
