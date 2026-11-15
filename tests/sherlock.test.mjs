// Sherlock, the relatives finder (#44), site side: starting a run and validating its options, what reaches the agent,
// how candidates are checked (already in the tree, possibly living), and how accepted ones land in the tree. The
// agents are a fake env.AGENTS; the shared logic runs directly. Fictional example family only.
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
let env, call, calls, R, Bundle;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ft-sh-"));
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
  R = await import("../worker/agent/relatives.js");
  Bundle = await import("../worker/bundle.js");
});

const b = async () => (await Bundle.scopedFor(env, EDITOR, "all")).bundle;
const start = (body, as = EDITOR) => call("POST", "/api/agent/runs", { as, body: { tree: "all", kind: "relatives", ...body } });
const runRow = (id) => env.DB.prepare("SELECT * FROM agent_runs WHERE id = ?").bind(id).first();
const SRC = [{ title: "Exampleton parish register, baptisms 1928", url: "https://records.example.org/exampleton/bap/1928/12", note: "original register image, entry 12, names George's parents" }];
// George Hartley (I4), 1931–2004: parents Arthur (I8) and Florence (I9) in family F4, a brother Thomas (I17), wife Eva (I5).
const SUBJECT = "I4";

test("an editor starts Sherlock from a person who has died, with or without the optional fields", async () => {
  assert.equal((await start({ person: SUBJECT }, MEMBER)).status, 403);
  assert.equal((await start({})).status, 400);
  assert.equal((await start({ person: "I999" })).status, 404);
  assert.equal((await start({ person: "I2" })).status, 400, "living people aren't researched");
  assert.equal((await start({ person: SUBJECT, looking_for: "cousins" })).status, 400);
  assert.equal((await start({ person: SUBJECT, depth: 3 })).status, 400);
  assert.equal((await start({ person: SUBJECT, looking_for: "named" })).status, 400, "a named relative needs a name");

  const r = await start({ person: SUBJECT });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.run.kind, "relatives");
  assert.deepEqual(r.data.run.options, { looking_for: "any", depth: 1, count: 0 });
  let sent = calls.at(-1);
  assert.equal(sent.url, `/agents/sherlock/${r.data.run.id}`);
  assert.deepEqual(sent.body.initialData, { runId: r.data.run.id });
  const msg = sent.body.body;
  assert.match(msg, /Find relatives of George Hartley \(I4\)/);
  assert.match(msg, /"id":"I4"/, "the person's full view");
  assert.match(msg, /parents: Arthur Hartley \(I8, b\. 1899, d\. 1966\); Florence Pike \(I9/);
  assert.match(msg, /siblings: Thomas Hartley \(I17/);
  assert.match(msg, /children: Daniel James Hartley \(I2, living\)/);
  assert.ok(!/1960/.test(msg.split("Immediate family")[1].split("\n").find((l) => l.includes("I2"))), "no dates for the living");
  assert.match(msg, /Research sites \(the owner's list\)/);
  assert.match(msg, /FamilySearch · familysearch\.org/);
  assert.ok(msg.length < 20000, `${msg.length} chars`);

  const r2 = await start({ person: SUBJECT, looking_for: "named", named: "a brother called Example", hints: "The family may have come through Exampleport around 1905.", depth: 2 });
  assert.equal(r2.status, 201, JSON.stringify(r2.data));
  assert.deepEqual(r2.data.run.options, { looking_for: "named", named: "a brother called Example", hints: "The family may have come through Exampleport around 1905.", depth: 2, count: 0 });
  sent = calls.at(-1);
  assert.match(sent.body.body, /a specific relative: a brother called Example/);
  assert.match(sent.body.body, /Exampleport around 1905/);
  assert.match(sent.body.body, /Depth: two generations/);
  // the research runs' first message carries the sites list too
  await call("POST", "/api/agent/runs", { as: EDITOR, body: { tree: "all", person: "I8" } });
  assert.match(calls.at(-1).body.body, /Research sites \(the owner's list\)/);
});

test("the living filter: no death record and born within 110 years, or birth unknown, means possibly living", () => {
  assert.equal(R.possiblyLiving({ born: { date: "12 Mar 1950" } }, YEAR), true);
  assert.equal(R.possiblyLiving({ born: { date: "abt 1917" } }, YEAR), true, "109 years ago");
  assert.equal(R.possiblyLiving({ born: { date: "1916" } }, YEAR), false, "110 years ago");
  assert.equal(R.possiblyLiving({ born: { date: "1880", place: "Exampleton" } }, YEAR), false);
  assert.equal(R.possiblyLiving({}, YEAR), true, "birth unknown");
  assert.equal(R.possiblyLiving({ born: { place: "Exampleton" } }, YEAR), true, "a place but no year");
  assert.equal(R.possiblyLiving({ born: { date: "1990" }, died: { date: "2001" } }, YEAR), false, "a death record");
  assert.equal(R.possiblyLiving({ died: { place: "Exampleton" } }, YEAR), false);
});

test("candidates already in the tree are dropped; the possibly living keep no details; the rest get ops", async () => {
  const id = (await start({ person: SUBJECT })).data.run.id;
  const run = await runRow(id);
  const B = await b();
  const sub = {
    summary: "Searched the Exampleton registers for George's family.",
    log: [{ searched: "Example Records: baptisms, Exampleton, 1920–1935, surname Hartley", result: "found" }, { searched: "Example Graves: Hartley, Exampleton", result: "nil" }],
    todo: [{ task: "Check the 1939 register for the Hartley household", priority: "medium" }],
    candidates: [
      { given: "Example", surname: "Hartley", sex: "M", relation: "sibling", born: { date: "4 Jun 1928", place: "Exampleton" }, died: { date: "1990" }, finding: "Baptised 1928, son of Arthur and Florence Hartley.", confidence: "medium", sources: SRC },
      { given: "Thomas", surname: "Hartley", relation: "sibling", born: { date: "1925" }, died: { date: "1999" }, finding: "Brother Thomas.", confidence: "high", sources: SRC },
      { given: "Florence", surname: "Pike", sex: "F", relation: "parent", born: { date: "abt 1902" }, died: { date: "1979" }, finding: "Mother.", confidence: "high", sources: SRC },
      { given: "Example", surname: "Name", sex: "F", relation: "sibling", born: { date: "1950" }, finding: "A sister born 1950 at 1 Example Street.", confidence: "low", sources: SRC },
      { given: "Example", surname: "Exampleton", sex: "F", relation: "spouse", born: { date: "1932" }, died: { date: "1956" }, married: { date: "1952", place: "Exampleton" }, finding: "A first marriage in 1952.", confidence: "low", sources: SRC },
    ],
  };
  const r = await R.checkRelatives(env, B, run, sub, { year: YEAR });
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepEqual(r.value.already_in_tree.map((x) => x.id).sort(), ["I17", "I9"]);
  assert.deepEqual(r.value.living, [{ relation: "sibling", of: SUBJECT }]);
  assert.ok(!JSON.stringify(r.value.living).includes("Example Street") && !JSON.stringify(r.value.living).includes("Name"));
  assert.deepEqual(r.value.candidates.map((c) => c.name), ["Example Hartley", "Example Exampleton"]);
  const [sib, sp] = r.value.candidates;
  assert.deepEqual(sib.ops[1], { op: "family.add_child", family: "F4", person: "$new" });
  assert.equal(sib.ops[0].op, "person.create");
  assert.deepEqual(sib.ops[0].events.map((e) => [e.type, e.date]), [["Birth", "4 Jun 1928"], ["Death", "1990"]]);
  assert.equal(sib.ops[0].events[0].citations[0].url, SRC[0].url);
  assert.deepEqual(sib.finding.proposed_ops, sib.ops);
  assert.equal(sib.finding.kind, "new-person");
  assert.equal(sib.finding.person, SUBJECT);
  assert.deepEqual(sp.ops[1], { op: "family.create", husband: SUBJECT, wife: "$new", events: [{ type: "Marriage", date: "1952", place: "Exampleton", citations: [{ title: SRC[0].title, url: SRC[0].url, note: SRC[0].note }] }] });

  // what's wrong is reported back to the agent
  const bad = await R.checkRelatives(env, B, run, { summary: "x", log: [], candidates: [
    { given: "Example", surname: "Hartley", relation: "parent", sex: "M", born: { date: "1890" }, died: { date: "1950" }, finding: "A father.", confidence: "low", sources: SRC },
    { given: "Example", surname: "Pike", relation: "cousin", born: { date: "1890" }, died: { date: "1950" }, finding: "?", confidence: "low", sources: SRC },
    { given: "Example", surname: "Novák", relation: "sibling", of: "I5", born: { date: "1890" }, died: { date: "1950" }, finding: "Eva's brother.", confidence: "low", sources: SRC },
    { given: "Example", surname: "Costa", relation: "sibling", born: { date: "1890" }, died: { date: "1950" }, finding: "No source.", confidence: "low", sources: [] },
  ] }, { year: YEAR });
  assert.equal(bad.ok, false);
  const errs = bad.errors.join("\n");
  assert.match(errs, /log: log every search/);
  assert.match(errs, /candidates\[0\]: .*already has a father recorded/);
  assert.match(errs, /candidates\[1\]: relation must be/);
  assert.match(errs, /candidates\[2\]: of must be I4/, "depth 1 attaches only to the person");
  assert.match(errs, /candidates\[3\]: no sources/);
});

test("a run against the fictional family proposes nobody who is already in the tree", async () => {
  const id = (await start({ person: SUBJECT, depth: 2 })).data.run.id;
  const B = await b();
  // the agent "finds" everyone already recorded, as the records spell them (dates within a year or two)
  const cands = Object.values(B.people).filter((p) => p.id !== SUBJECT).map((p) => ({
    given: (p.name.split(" ")[0]), surname: p.name.split(" ").at(-1), relation: "sibling",
    born: { date: p.birth && p.birth.year ? `abt ${p.birth.year + 1}` : "1900" }, died: { date: p.death && p.death.year ? String(p.death.year) : "1950" },
    finding: "Seen in a record.", confidence: "low", sources: SRC,
  }));
  const r = await R.checkRelatives(env, B, await runRow(id), { summary: "Everyone.", log: [{ searched: "Example Records", result: "found" }], candidates: cands }, { year: YEAR });
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepEqual(r.value.candidates, []);
  assert.equal(r.value.already_in_tree.length, cands.length);
  const done = await R.submitRelatives(env, id, r.value);
  const kinds = (await env.DB.prepare(`SELECT kind FROM proposals WHERE id IN (${done.proposals.join(",")})`).all()).results.map((x) => x.kind);
  assert.deepEqual(kinds, ["research"], "only the search log is filed");
});

test("filing: one suggestion per candidate plus the log; accepting one adds the person and the link as Sherlock on behalf of the editor", async () => {
  const id = (await start({ person: SUBJECT })).data.run.id;
  const B = await b();
  const r = await R.checkRelatives(env, B, await runRow(id), {
    summary: "Found a brother and a first wife.",
    log: [{ searched: "Example Records: baptisms, Exampleton, 1920–1935, surname Hartley", result: "found" }],
    todo: [{ task: "Order the 1952 marriage certificate", where: "Exampleshire register office", priority: "low" }],
    candidates: [
      { given: "Example", surname: "Hartley", sex: "M", relation: "sibling", born: { date: "4 Jun 1928", place: "Exampleton" }, died: { date: "1990" }, finding: "Baptised 1928, son of Arthur and Florence Hartley.", confidence: "medium", sources: SRC },
      { given: "Example", surname: "Exampleton", sex: "F", relation: "spouse", born: { date: "1932" }, died: { date: "1956" }, finding: "A first marriage in 1952.", confidence: "low", sources: SRC },
      { given: "Example", surname: "Name", relation: "child", finding: "A child.", confidence: "low", sources: SRC },
    ],
  }, { year: YEAR });
  assert.ok(r.ok, JSON.stringify(r.errors));
  const done = await R.submitRelatives(env, id, r.value);
  assert.equal(done.proposals.length, 3);
  assert.deepEqual(await R.submitRelatives(env, id, r.value).then((x) => x.proposals), done.proposals, "idempotent");
  const run = (await call("GET", `/api/agent/runs/${id}`, { as: EDITOR })).data.run;
  assert.equal(run.status, "succeeded");
  assert.equal(run.summary, "Found a brother and a first wife.");
  assert.deepEqual(run.report.candidates.map((c) => [c.name, c.relation, c.proposal]), [["Example Hartley", "sibling", done.proposals[0]], ["Example Exampleton", "spouse", done.proposals[1]]]);
  assert.deepEqual(run.report.living, [{ relation: "child", of: SUBJECT }]);
  assert.equal(run.report.research, done.proposals[2]);
  assert.ok((await call("GET", "/api/agent/runs?tree=all", { as: EDITOR })).data.runs.some((x) => x.id === id && x.kind === "relatives"));

  const q = (await call("GET", "/api/proposals?tree=all&status=open", { as: EDITOR })).data.proposals;
  const sib = q.find((p) => p.id === done.proposals[0]);
  assert.equal(sib.kind, "edit");
  assert.equal(sib.author, R.SHERLOCK);
  assert.equal(sib.payload.findings[0].kind, "new-person");
  assert.equal(q.find((p) => p.id === done.proposals[2]).kind, "research");
  assert.ok(!JSON.stringify(q).includes("Example Name"), "the possibly living child is nowhere in the suggestions");

  // accept the brother in one step
  const ok = await call("POST", `/api/proposals/${done.proposals[0]}/approve`, { as: EDITOR, body: {} });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const tree = (await call("GET", "/api/tree?tree=all", { as: EDITOR })).data;
  const added = Object.values(tree.people).find((p) => p.name === "Example Hartley");
  assert.ok(added, "the person is in the tree");
  assert.ok(tree.families.F4.children.includes(added.id), "linked as George's sibling");
  const rows = (await env.DB.prepare("SELECT actor, actor_kind, on_behalf_of, via, proposal_id FROM changes WHERE batch_id = ?").bind(ok.data.batch).all()).results;
  assert.ok(rows.length >= 2);
  for (const x of rows) assert.deepEqual(x, { actor: R.SHERLOCK, actor_kind: "agent", on_behalf_of: EDITOR, via: id, proposal_id: done.proposals[0] });
  const f = tree.research.findings.find((x) => x.kind === "new-person" && x.person === SUBJECT && x.finding.startsWith("Baptised 1928"));
  assert.equal(f.resolution.status, "resolved");
  assert.equal(f.resolution.batch, ok.data.batch);

  // reject the spouse: nothing changes in the tree; the finding is kept as dismissed
  assert.equal((await call("POST", `/api/proposals/${done.proposals[1]}/reject`, { as: EDITOR, body: { note: "a different George" } })).status, 200);
  const t2 = (await call("GET", "/api/tree?tree=all", { as: EDITOR })).data;
  assert.ok(!Object.values(t2.people).some((p) => p.name === "Example Exampleton"));
  const f2 = t2.research.findings.find((x) => x.finding === "A first marriage in 1952.");
  assert.equal(f2.resolution.status, "dismissed");
  assert.equal(f2.resolution.note, "a different George");
});
