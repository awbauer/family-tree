// The stories agent (#33): reviewing a story and drafting a new one, both only ever as a suggestion. Checks that a
// submission links only real people, cites only the tree's sources, and keeps people private in the starter's view
// out of the subject;
// approving files the story like any research suggestion. The agents are a fake env.AGENTS.
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
const NAMES = "names@example.test"; // an editor whose view reduces living people to their names (private)
let env, call, calls, St, Bundle, story;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ft-st-"));
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
  await call("PUT", "/api/admin/views/names", { body: { name: "Names only", filter: { living: "names-only" } } });
  await call("PUT", "/api/admin/grants", { body: { principal: NAMES, tree_id: "all", role: "editor", view_id: "names" } });
  St = await import("../worker/agent/stories.js");
  Bundle = await import("../worker/bundle.js");
  story = research.stories[0];
});

const b = async () => (await Bundle.scopedFor(env, EDITOR, "all")).bundle;
const start = (body, as = EDITOR) => call("POST", "/api/agent/runs", { as, body: { tree: "all", kind: "story", ...body } });
const runRow = (id) => env.DB.prepare("SELECT * FROM agent_runs WHERE id = ?").bind(id).first();
const dead = async () => Object.values((await b()).people).filter((p) => !p.living && !p.private && (p.events || []).some((e) => (e.citations || []).length));
const living = async () => Object.values((await b()).people).find((p) => p.living);
const citedTitle = async (p) => { const B = await b(); const c = p.events.flatMap((e) => e.citations || [])[0]; return ((B.sources || {})[c.source] || {}).title || c.title || c.source; };
const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

test("editors start story runs; drafts may be about living relatives, not about people private in the starter's view", async () => {
  assert.equal((await start({ mode: "review", slug: story.slug }, MEMBER)).status, 403);
  assert.equal((await start({ mode: "review", slug: "no-such-story" })).status, 404);
  let r = await start({ mode: "review", slug: story.slug, instructions: "Make it shorter" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.run.kind, "story");
  assert.equal(calls.at(-1).url, `/agents/stories/${r.data.run.id}`);
  assert.match(calls.at(-1).body.body, /get_story\("eva-comes-to-england"\)/);
  assert.match(calls.at(-1).body.body, /Make it shorter/);
  const lv = await living();
  const refused = await start({ mode: "draft", people: [lv.id] }, NAMES);
  assert.equal(refused.status, 400, "private in the starter's view");
  assert.match(refused.data.error, /private in your view/);
  r = await start({ mode: "draft", people: [lv.id] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.match(calls.at(-1).body.body, new RegExp(lv.id));
  assert.equal((await start({ mode: "draft", people: [] })).status, 400);
  r = await start({ mode: "draft", people: [(await dead())[0].id], length: "short" });
  assert.equal(r.status, 201);
  assert.match(calls.at(-1).body.body, /about 300 words/);
});

test("a review submission is checked; a revision becomes a suggestion that approving applies", async () => {
  const B = await b(), o = { mode: "review", slug: story.slug, instructions: "Make it shorter" };
  let r = St.checkStory(B, o, { summary: "s", body: story.body, changes: [{ change: "c", reason: "r" }] });
  assert.match(r.errors.join(), /unchanged/);
  r = St.checkStory(B, o, { summary: "s", body: "[[I999999|Nobody]] went somewhere.", changes: [{ change: "c", reason: "r" }] });
  assert.match(r.errors.join(), /isn't in this tree/);
  r = St.checkStory(B, o, { summary: "s", body: "Shorter." });
  assert.match(r.errors.join(), /changes/);
  assert.equal(St.checkStory(B, { ...o, instructions: null }, { summary: "Accurate as it is.", up_to_date: true }).value.up_to_date, true);

  const revised = `${story.body.split(/\n\n/)[0]}\n\nAn example closing paragraph.`;
  r = St.checkStory(B, o, { summary: "Shortened it.", body: revised, changes: [{ change: "Cut the second section", reason: "The editor asked for a shorter story", facts: ["I5 e1"] }] });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const run = (await start(o)).data.run;
  const done = await St.submitStory(env, await runRow(run.id), r.value);
  assert.equal(done.proposals.length, 1);
  assert.equal((await runRow(run.id)).status, "succeeded");
  assert.deepEqual(await St.submitStory(env, await runRow(run.id), r.value), { status: "succeeded", proposals: done.proposals }, "idempotent");
  const prop = await env.DB.prepare("SELECT * FROM proposals WHERE id = ?").bind(done.proposals[0]).first();
  assert.equal(prop.author, "agent:stories");
  assert.equal((await call("GET", "/api/tree?tree=all", { as: EDITOR })).data.research.stories.find((x) => x.slug === story.slug).body, story.body, "nothing changes before approval");
  const ap = await call("POST", `/api/proposals/${prop.id}/approve`, { as: OWNER, body: { tree: "all" } });
  assert.equal(ap.status, 200, JSON.stringify(ap.data));
  const now = (await call("GET", "/api/tree?tree=all", { as: EDITOR })).data.research.stories.find((x) => x.slug === story.slug);
  assert.equal(now.body, revised);
  assert.deepEqual(now.sources, story.sources, "the story keeps its citations");
  assert.equal(now.changes, undefined);
});

test("a draft links its subjects, cites only the tree's sources, and is the right length", async () => {
  const B = await b(), p = (await dead())[0], title = await citedTitle(p);
  const o = { mode: "draft", people: [p.id], length: "short" };
  const good = { summary: "A short example story.", title: "An example life", era: "1900s", body: `[[${p.id}|${p.name}]] ${words(290)}`, sources: [{ title, note: "birth and death" }], notes: [{ paragraph: "1", facts: [`${p.id} e1`] }] };
  assert.match(St.checkStory(B, o, { ...good, body: words(300) }).errors.join(), /link/);
  assert.match(St.checkStory(B, o, { ...good, body: `[[${p.id}|x]] ${words(20)}` }).errors.join(), /words/);
  assert.match(St.checkStory(B, o, { ...good, sources: [{ title: "Example invented register" }] }).errors.join(), /isn't a source the tree cites/);
  assert.match(St.checkStory(B, o, { ...good, sources: [] }).errors.join(), /sources/);
  assert.match(St.checkStory(B, o, { ...good, notes: [] }).errors.join(), /notes/);
  const ctx = St.siteContext(B)[0];
  assert.equal(St.checkStory(B, o, { ...good, sources: [{ title }, { title: ctx.title }] }).ok, true, "context entries may be cited");
  const r = St.checkStory(B, o, good);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  // a living relative linked in a full view is one of the story's people, like anyone else
  const lv = await living();
  const kin = St.checkStory(B, o, { ...good, body: `${good.body} [[${lv.id}|${lv.name}]]` });
  assert.equal(kin.ok, true, JSON.stringify(kin.errors));
  assert.ok(JSON.stringify(kin.value.batch.stories[0].people).includes(lv.id), JSON.stringify(kin.value.batch));
  const run = (await start(o)).data.run;
  const { proposals: [pid] } = await St.submitStory(env, await runRow(run.id), r.value);
  const payload = JSON.parse((await env.DB.prepare("SELECT payload FROM proposals WHERE id = ?").bind(pid).first()).payload);
  assert.equal(payload.story_notes.length, 1);
  assert.equal((await call("POST", `/api/proposals/${pid}/approve`, { as: OWNER, body: { tree: "all" } })).status, 200);
  const made = (await call("GET", "/api/tree?tree=all", { as: EDITOR })).data.research.stories.find((x) => x.title === "An example life");
  assert.ok(made);
  assert.deepEqual(made.people, [p.id]);
  assert.equal(made.notes, undefined, "reviewer notes don't reach the published story");
});

test("an up-to-date review files nothing", async () => {
  const o = { mode: "review", slug: story.slug };
  const run = (await start(o)).data.run;
  const r = St.checkStory(await b(), o, { summary: "It matches the records.", up_to_date: true });
  const done = await St.submitStory(env, await runRow(run.id), r.value);
  assert.deepEqual(done.proposals, []);
  assert.equal(JSON.parse((await runRow(run.id)).result).up_to_date, true);
});
