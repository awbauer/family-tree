// The read-only SQL views of migration 0013 (tree_people, tree_person_names, tree_person_events, tree_family_members,
// tree_family_events, tree_citations) must say exactly what the JSON records say, in both storage layouts:
// `npm test` checks the working layout, `npm run test:gedcomx` the GEDCOM X one. The reference is the storage
// layer's own reading of the tree (worker/storage.js readTree).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEnv, client, migrate } from "./helpers/fake-env.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "owner@example.test";
let env, tree;
const rows = async (sql) => (await env.DB.prepare(sql).all()).results;
const nil = (v) => (v === undefined || v === "" ? null : v);

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ft-views-"));
  execFileSync("python3", ["tools/build.py", "--data", "example", "--out", dir, "--raw-out", join(dir, "raw.json")], { cwd: ROOT });
  execFileSync("python3", ["tools/seed_app.py", "--raw", join(dir, "raw.json"), "--bundle", join(dir, "family.json"),
    "--research", join(ROOT, "example/research.json"), "--out", join(dir, "seed.sql"), "--owner", OWNER, "--cutover"], { cwd: ROOT });
  env = makeEnv();
  migrate(env.DB, ROOT);
  env.DB.execFile(join(dir, "seed.sql"));
  const worker = (await import("../worker/index.js")).default;
  const call = client(worker, env);
  // an edit with the shapes worth checking: a second name, an event with a citation and a dual date, a one-parent family
  const r = await call("POST", "/api/edit", { body: { reason: "test", ops: [
    { op: "name.add", person: "I4", name: { given: "Georgie", surname: "Hartley", type: "nickname" } },
    { op: "event.add", entity: "person", id: "I4", event: { type: "Residence", date: "12 Feb 1750/51", place: "Example Town", citations: [{ source: "S2", page: "p. 9" }] } },
    { op: "family.create", id: "F90", wife: "I18", children: ["I17"], events: [{ type: "Marriage", date: "Abt 1950", place: "Example Chapel" }] },
  ] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  tree = await (await import("../worker/storage.js")).readTree(env);
  console.log(`storage layout: ${tree.mode}`);
});

test("tree_people: one row per person, with sex, main name, birth and death", async () => {
  const out = await rows("SELECT * FROM tree_people");
  assert.equal(out.length, Object.keys(tree.people).length);
  for (const v of out) {
    const p = tree.people[v.id], n = p.names[0] || {};
    const first = (t) => (p.events || []).find((e) => e.type === t) || {};
    assert.equal(nil(v.sex), nil(p.sex), v.id);
    assert.equal(nil(v.given), nil(n.given), v.id);
    assert.equal(nil(v.surname), nil(n.surname), v.id);
    assert.equal(nil(v.birth_date), nil(first("Birth").date), v.id);
    assert.equal(nil(v.birth_place), nil(first("Birth").place), v.id);
    assert.equal(nil(v.death_date), nil(first("Death").date), v.id);
    assert.equal(v.name_count, p.names.length);
    assert.equal(v.event_count, (p.events || []).length);
  }
  const g = out.find((x) => x.id === "I4");
  assert.equal(g.name, "George Hartley");
  assert.equal(g.birth_year, 1931);
  assert.equal(g.death_year, 2004);
});

test("tree_person_names and tree_person_events: every name and fact, in order, with fact ids", async () => {
  const names = await rows("SELECT * FROM tree_person_names ORDER BY person_id, name_index");
  assert.equal(names.length, Object.values(tree.people).reduce((n, p) => n + p.names.length, 0));
  const nick = names.find((x) => x.person_id === "I4" && x.given === "Georgie");
  assert.equal(nick.name_type, "nickname");
  assert.match(nick.fid, /^n\d+$/);

  const events = await rows("SELECT * FROM tree_person_events");
  const want = Object.values(tree.people).flatMap((p) => (p.events || []).map((e, i) => [p.id, i, e]));
  assert.equal(events.length, want.length);
  const by = new Map(events.map((e) => [`${e.person_id}|${e.event_index}`, e]));
  for (const [pid, i, e] of want) {
    const v = by.get(`${pid}|${i}`);
    for (const k of ["fid", "type", "date", "place", "value", "note"]) assert.equal(nil(v[k]), nil(e[k]), `${pid} event ${i} ${k}`);
  }
  const res = events.find((e) => e.person_id === "I4" && e.place === "Example Town");
  assert.equal(res.year, null); // a dual date is left to the app's own parser
  assert.equal(events.find((e) => e.person_id === "I4" && e.type === "Occupation").year, 1961);
});

test("tree_family_members and tree_family_events match every family, including a one-parent family", async () => {
  const members = await rows("SELECT * FROM tree_family_members ORDER BY family_id, role, child_index");
  const want = Object.values(tree.families).flatMap((f) => [
    ...(f.husband ? [[f.id, f.husband, "husband"]] : []), ...(f.wife ? [[f.id, f.wife, "wife"]] : []),
    ...(f.children || []).map((c, i) => [f.id, c, "child", i])]);
  const key = (x) => x.slice(0, 3).join("|");
  assert.deepEqual(members.map((m) => key([m.family_id, m.person_id, m.role])).sort(), want.map(key).sort());
  for (const [fid, c, role, i] of want.filter((x) => x[2] === "child")) {
    assert.equal(members.find((m) => m.family_id === fid && m.person_id === c && m.role === role).child_index, i, `${fid} ${c}`);
  }
  assert.deepEqual(members.filter((m) => m.family_id === "F90").map((m) => `${m.role}:${m.person_id}`).sort(), ["child:I17", "wife:I18"]);

  const fev = await rows("SELECT * FROM tree_family_events");
  assert.equal(fev.length, Object.values(tree.families).reduce((n, f) => n + (f.events || []).length, 0));
  const m = fev.find((e) => e.family_id === "F90");
  assert.equal(m.type, "Marriage");
  assert.equal(m.year, 1950);
  assert.equal(m.place, "Example Chapel");
});

test("tree_citations: every citation on people, names, events and family events", async () => {
  const out = await rows("SELECT * FROM tree_citations");
  let n = 0;
  for (const p of Object.values(tree.people)) {
    n += (p.citations || []).length;
    for (const x of [...p.names, ...(p.events || [])]) n += (x.citations || []).length;
  }
  for (const f of Object.values(tree.families)) for (const e of f.events || []) n += (e.citations || []).length;
  assert.equal(out.length, n);
  const mine = out.find((c) => c.entity_id === "I4" && c.page === "p. 9");
  assert.equal(mine.source_id, "S2");
  assert.match(mine.fid, /^e\d+$/);
  assert.ok(out.some((c) => c.entity_id === "I4" && c.source_id === "S2" && c.page === "Vol. 2c, p. 411"));
});

test("people answer real questions in plain SQL", async () => {
  const q = await rows(`SELECT p.name, e.year FROM tree_person_events e JOIN tree_people p ON p.id = e.person_id
    WHERE e.type = 'Occupation' AND e.value LIKE '%conductor%'`);
  assert.deepEqual(q, [{ name: "George Hartley", year: 1961 }]);
  const kids = await rows(`SELECT DISTINCT c.person_id FROM tree_family_members c JOIN tree_family_members par ON par.family_id = c.family_id
    WHERE c.role = 'child' AND par.role IN ('husband','wife') AND par.person_id = 'I8' ORDER BY c.person_id`);
  assert.deepEqual(kids.map((k) => k.person_id), ["I17", "I4"]);
});
