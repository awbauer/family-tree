// Tree checks for the data quality review: what they find, the mechanical fixes they suggest, and how a review's
// decision on a check is applied (only while the problem is still the same; fixes only ever as suggestions).
// Fictional example family only.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEnv, client, migrate } from "./helpers/fake-env.mjs";
import { standardDate, treeChecks } from "../worker/agent/checks.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "owner@example.test", EDITOR = "editor@example.test";
let env, call, Q, Bundle, kid;

test("dates in standard genealogical form", () => {
  const cases = [["1 June 1915", "1 Jun 1915"], ["About 1887", "abt 1887"], ["Abt. 1995", "abt 1995"], ["Before 1951", "bef 1951"], ["May 13 1963", "13 May 1963"],
    ["mar 14, 1960", "14 Mar 1960"], ["October 12, 1978", "12 Oct 1978"], ["09 July 1996", "9 Jul 1996"], ["22 Sept 1920", "22 Sep 1920"], ["14 NOV 1902", "14 Nov 1902"],
    ["2 Jún 1877", "2 Jun 1877"], ["17 Szept 1885", "17 Sep 1885"]];
  for (const [a, b] of cases) assert.equal(standardDate(a), b, a);
  assert.equal(standardDate("1901-1903", "Marriage"), "bet 1901 and 1903");
  assert.equal(standardDate("1990-2020", "Residence"), "from 1990 to 2020");
  for (const ok of ["12 Mar 1891", "abt 1890", "1891", "Mar 1891", "bet 1890 and 1895"]) assert.equal(standardDate(ok), null, `${ok} is already standard`);
  for (const unsafe of ["5 Jul", "Jul", "sometime", "2020-1990"]) assert.equal(standardDate(unsafe), null, `${unsafe} is left alone`);
});

test("places written several ways settle on the spelled-out form the tree uses most", async () => {
  const { placeKey, placeStandards } = await import("../worker/agent/checks.js");
  const k = placeKey("Exampleton, Example State, USA");
  for (const v of ["Exampleton, ES", "Exampleton, E.S.", "Exampleton ES", "exampleton, Example State, United States", "Exampleton, Example State County, United States of America"]) assert.equal(placeKey(v), k, v);
  assert.notEqual(placeKey("Exampleton, Other State"), k);
  assert.notEqual(placeKey("Sampleville, Example State"), k);
  assert.notEqual(placeKey("Exampleton Lot 12, Example State"), placeKey("Exampleton Lot 15, Example State"), "numbered subdivisions stay distinct");
  const std = placeStandards({ "Exampleton, Example State, USA": 3, "Exampleton, ES": 4, "Exampleton, E.S.": 1, "Sampleville, Shire": 2 });
  assert.deepEqual(std, { "Exampleton, ES": "Exampleton, Example State, USA", "Exampleton, E.S.": "Exampleton, Example State, USA" });
});

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ft-chk-"));
  execFileSync("python3", ["tools/build.py", "--data", "example", "--out", dir, "--raw-out", join(dir, "raw.json")], { cwd: ROOT });
  const research = JSON.parse(readFileSync(join(ROOT, "example/research.json"), "utf8"));
  research.trees = [{ id: "all", name: "Everyone", definition: { branches: ["*"] } }];
  writeFileSync(join(dir, "research.json"), JSON.stringify(research));
  execFileSync("python3", ["tools/seed_app.py", "--raw", join(dir, "raw.json"), "--bundle", join(dir, "family.json"), "--research", join(dir, "research.json"), "--out", join(dir, "seed.sql"), "--owner", OWNER, "--cutover"], { cwd: ROOT });
  env = makeEnv({ AGENTS: { fetch: async () => new Response("{}", { status: 202 }) } });
  migrate(env.DB, ROOT);
  env.DB.execFile(join(dir, "seed.sql"));
  call = client((await import("../worker/index.js")).default, env);
  await call("PUT", "/api/admin/grants", { body: { principal: EDITOR, tree_id: "all", role: "editor" } });
  Q = await import("../worker/agent/quality.js");
  Bundle = await import("../worker/bundle.js");
  // plant problems: a duplicate of someone with parents, the same couple twice, an empty record, a non-standard date
  const B = (await Bundle.scopedFor(env, OWNER, "all")).bundle;
  kid = Object.values(B.people).find((p) => !p.living && (p.famc || []).length && p.birth && p.birth.year);
  const fam = B.families[kid.famc[0]];
  const r = await call("POST", "/api/edit", { body: { tree: "all", reason: "Example: plant problems for the checks", ops: [
    { op: "person.create", id: "$dup", names: [{ given: kid.given, surname: kid.surname }], sex: kid.sex, events: [{ type: "Birth", date: String(kid.birth.year) }] },
    { op: "family.add_child", family: fam.id, person: "$dup" },
    { op: "family.create", husband: fam.husband, wife: fam.wife },
    { op: "person.create", id: "$empty", names: [{ given: "Example", surname: "Nobody" }] },
    { op: "event.add", entity: "person", id: kid.id, event: { type: "Residence", date: "1 June 1925", place: "Example Town, ES" } },
    { op: "event.add", entity: "person", id: kid.id, event: { type: "Residence", date: "1930", place: "Example Town, Example State, USA" } },
    { op: "event.add", entity: "person", id: kid.id, event: { type: "Residence", date: "1935", place: "Example Town, Example State, USA" } },
  ] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
});

const bundle = async () => (await Bundle.scopedFor(env, EDITOR, "all")).bundle;

test("the checks find planted problems and suggest mechanical fixes", async () => {
  const cs = treeChecks(await bundle());
  const kinds = new Set(cs.map((c) => c.kind));
  for (const k of ["duplicate-person", "duplicate-family", "empty-record", "disconnected", "date-format", "place-format"]) assert.ok(kinds.has(k), `finds ${k}`);
  const dup = cs.find((c) => c.kind === "duplicate-person" && c.detail.people.includes(kid.id));
  assert.equal(dup.detail.suggested_ops[0].op, "person.merge");
  assert.equal(dup.detail.suggested_ops[0].keep, kid.id, "keeps the record with more facts");
  assert.equal(cs.find((c) => c.kind === "duplicate-family").detail.suggested_ops[0].op, "family.merge");
  assert.ok(cs.find((c) => c.kind === "date-format").detail.suggested_ops.some((o) => o.set.date === "1 Jun 1925"));
  assert.ok(cs.find((c) => c.kind === "place-format").detail.suggested_ops.some((o) => o.set.place === "Example Town, Example State, USA"));
  assert.equal(cs[0].detail.severity, "error", "most serious first");
  const mine = treeChecks(await bundle(), { person: kid.id });
  assert.ok(mine.every((c) => !c.detail.people || c.detail.people.includes(kid.id) || c.kind.endsWith("-format")));
});

test("a couple recorded the wrong way round gets one swap", async () => {
  const B = await bundle();
  const f = Object.values(B.families).find((x) => x.husband && x.wife && B.people[x.husband].sex === "M" && B.people[x.wife].sex === "F");
  assert.equal((await call("POST", "/api/edit", { body: { tree: "all", reason: "Example: swap", ops: [{ op: "family.swap_spouses", family: f.id }] } })).status, 200);
  const cs = treeChecks(await bundle());
  const sw = cs.find((c) => c.kind === "swapped-spouses" && c.id === `swapped-spouses:${f.id}`);
  assert.deepEqual(sw.detail.suggested_ops, [{ op: "family.swap_spouses", family: f.id }]);
  assert.ok(!cs.some((c) => c.kind === "sex-role" && sw.detail.people.includes(c.person)), "not also reported person by person");
  assert.equal((await call("POST", "/api/edit", { body: { tree: "all", reason: "Example: swap back", ops: [{ op: "family.swap_spouses", family: f.id }] } })).status, 200);
});

test("a review plans checks, files a confirmed fix as a suggestion, and skips it once the problem is gone", async () => {
  const r = await call("POST", "/api/agent/runs", { as: EDITOR, body: { tree: "all", kind: "quality", scope: "checks", limit: 100 } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const run = await env.DB.prepare("SELECT * FROM agent_runs WHERE id = ?").bind(r.data.run.id).first();
  const items = JSON.parse(run.options).items;
  assert.ok(items.every((x) => x.type === "check"));
  const sc = await Bundle.scopedFor(env, EDITOR, "all");
  const dupRef = items.find((x) => x.kind === "duplicate-person").ref;
  const view = await Q.itemView(env, sc.bundle, dupRef);
  assert.ok(view.suggested_ops && view.people.length === 2);
  const famRef = items.find((x) => x.kind === "duplicate-family").ref;
  const famView = await Q.itemView(env, sc.bundle, famRef);
  const decide = async (ref, input) => { const c = await Q.checkDecision(env, sc, await env.DB.prepare("SELECT * FROM agent_runs WHERE id = ?").bind(run.id).first(), { item: ref, ...input }); assert.equal(c.ok, true, JSON.stringify(c.errors)); return Q.recordDecision(env, await env.DB.prepare("SELECT * FROM agent_runs WHERE id = ?").bind(run.id).first(), c.decision); };
  let d = await decide(dupRef, { verdict: "still_valid", note: "Same name, same parents, same birth year.", fix: { reason: "Duplicate record", ops: view.suggested_ops } });
  assert.deepEqual([d.status, d.detail], ["would", "suggest the fix"]);
  d = await decide(famRef, { verdict: "still_valid", note: "The same couple twice.", fix: { reason: "Duplicate family", ops: famView.suggested_ops } });
  assert.equal(d.status, "would");
  const emptyRef = items.find((x) => x.kind === "empty-record").ref;
  d = await decide(emptyRef, { verdict: "needs_human", note: "No facts; ask the owner.", new_todos: [{ task: "Example: find out who this record was meant to be", priority: "low" }] });
  assert.equal(d.detail, "add 1 to-do");
  // meanwhile, someone merges the duplicate couple by hand
  const B = await bundle();
  const famIds = Object.values(B.families).filter((f) => f.husband === B.families[kid.famc[0]].husband && f.wife === B.families[kid.famc[0]].wife).map((f) => f.id);
  assert.equal((await call("POST", "/api/edit", { body: { tree: "all", reason: "Example: merged by hand", ops: [{ op: "family.merge", keep: famIds[0], drop: famIds[1] }] } })).status, 200);
  await env.DB.prepare("UPDATE agent_runs SET status = 'succeeded' WHERE id = ?").bind(run.id).run();
  const ap = await call("POST", `/api/agent/runs/${run.id}/apply`, { as: EDITOR });
  assert.equal(ap.status, 200, JSON.stringify(ap.data));
  const by = Object.fromEntries(ap.data.report.map((x) => [x.item, x]));
  assert.equal(by[dupRef].status, "applied");
  const prop = await env.DB.prepare("SELECT kind, status, payload FROM proposals WHERE id = ?").bind(by[dupRef].proposal).first();
  assert.deepEqual([prop.kind, prop.status, JSON.parse(prop.payload).ops[0].op], ["edit", "open", "person.merge"], "the merge is only suggested");
  assert.ok((await bundle()).people[view.suggested_ops[0].drop], "nothing merged yet");
  assert.equal(by[famRef].status, "skipped", "the couple was merged meanwhile");
  assert.equal(by[emptyRef].status, "applied");
  assert.ok(await env.DB.prepare("SELECT 1 FROM todos WHERE task LIKE 'Example: find out who%'").first());
});
