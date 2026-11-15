// GEDCOM X: lossless conversion, storage as Person/relationship rows, the upgrade, export and import.
// Fictional example family and synthetic records only.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEnv, migrate } from "./helpers/fake-env.mjs";
import * as GX from "../worker/gedcomx.js";
import * as Storage from "../worker/storage.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "owner@example.test", EDITOR = "editor@example.test", MEMBER = "member@example.test";
const G = "http://gedcomx.org/", FT = GX.FT;
let seedSql, worker;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ft-gx-"));
  execFileSync("python3", ["tools/build.py", "--data", "example", "--out", dir, "--raw-out", join(dir, "raw.json")], { cwd: ROOT });
  const research = JSON.parse(readFileSync(join(ROOT, "example/research.json"), "utf8"));
  research.trees = [{ id: "all", name: "Everyone", definition: { branches: ["*"] } }];
  writeFileSync(join(dir, "research.json"), JSON.stringify(research));
  execFileSync("python3", ["tools/seed_app.py", "--raw", join(dir, "raw.json"), "--bundle", join(dir, "family.json"), "--research", join(dir, "research.json"), "--out", join(dir, "seed.sql"), "--owner", OWNER, "--cutover"], { cwd: ROOT });
  seedSql = join(dir, "seed.sql");
  worker = (await import("../worker/index.js")).default;
});

/** A fresh seeded database (in the original layout, whatever FT_STORAGE says) and a caller for it. */
async function fresh({ seed = true } = {}) {
  const env = makeEnv();
  migrate(env.DB, ROOT);
  if (seed) env.DB.execFile(seedSql);
  const call = async (method, path, { as = OWNER, body, raw } = {}) => {
    const res = await worker.fetch(new Request(`https://x.test${path}`, { method, headers: { "X-Dev-Principal": as, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil() {} });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, type: res.headers.get("Content-Type") };
  };
  if (seed) {
    await call("PUT", "/api/admin/grants", { body: { principal: EDITOR, tree_id: "all", role: "editor" } });
    await call("PUT", "/api/admin/grants", { body: { principal: MEMBER, tree_id: "all", role: "member" } });
  }
  return { env, call };
}
const tree = async (call, as = OWNER) => (await call("GET", "/api/tree?tree=all", { as })).data;
const shape = (b) => ({
  people: Object.fromEntries(Object.values(b.people).map((p) => [p.id, { names: p.names.map((n) => `${n.given}|${n.surname}`), sex: p.sex, famc: p.famc, fams: p.fams, events: p.events.map((e) => [e.fid, e.type, e.date || "", e.place || ""].join("|")) }])),
  families: Object.fromEntries(Object.values(b.families).map((f) => [f.id, { husband: f.husband, wife: f.wife, children: f.children, events: f.events.map((e) => [e.type, e.date || ""].join("|")) }])),
});

test("formal dates follow GEDCOM X", () => {
  const cases = { "2 Feb 1931": "+1931-02-02", "Mar 1931": "+1931-03", "1931": "+1931", "abt 1890": "A+1890", "est 1880": "A+1880", "bef 1900": "/+1900", "aft 1850": "+1850/", "bet 1890 and 1895": "+1890/+1895", "from 1900 to 1910": "+1900/+1910", "(sometime)": undefined, "": undefined };
  for (const [s, f] of Object.entries(cases)) assert.equal(GX.formalDate(s), f, s);
});

test("conversion is lossless, including the awkward cases", () => {
  const raw = {
    people: {
      A: { id: "A", names: [{ given: "Ann", surname: "Example", suffix: "", type: "birth", fid: "n1", review: { status: "verified", by: "x@example.test", at: "2026-01-01T00:00:00Z", note: "ok", evidence: [{ title: "Register" }] } }], sex: "F", famc: [], fams: ["F1", "F2"],
        events: [{ type: "Birth", date: "abt 1890", place: "Leeds", fid: "e1", citations: [{ source: "", page: "p. 4" }, { title: "Ad hoc", url: "https://example.org/r", source_type: "original", information: "primary", evidence: "direct", quality: "3" }] },
          { type: "Hobby", value: "chess", fid: "e2", subtype: "x", address: "y", age: "40" }],
        notes: ["n"], citations: [{ source: "S1" }], media: ["O1"], origin: "graft", mergedFrom: ["Z"] },
      B: { id: "B", names: [{ given: "Bob", surname: "Example", suffix: "", type: "" }], sex: "M", famc: [], fams: ["F1"], events: [], notes: [], citations: [], media: [] },
      C: { id: "C", names: [{ given: "Cy", surname: "Example", suffix: "", type: "" }], sex: "U", famc: ["F1", "F3"], fams: [], events: [], notes: [], citations: [], media: [] },
      D: { id: "D", names: [{ given: "Di", surname: "Example", suffix: "", type: "" }], sex: "F", famc: ["F2"], fams: [], events: [], notes: [], citations: [], media: [] },
    },
    families: {
      F1: { id: "F1", husband: "B", wife: "A", children: ["C"], events: [{ type: "Marriage", date: "1910", fid: "e1" }] },
      F2: { id: "F2", husband: null, wife: "A", children: ["D"], events: [{ type: "Marriage", date: "1920", fid: "e1" }], origin: "graft" }, // unknown partner
      F3: { id: "F3", husband: null, wife: null, children: ["C"], events: [] }, // no known parents
    },
    sources: { S1: { id: "S1", title: "Census", author: "", publication: "", apid: "1,2" } },
    media: { O1: { id: "O1", file: "x.jpg", title: "Photo", kind: "photo", type: "image", date: "1950", place: "Leeds" } },
  };
  const doc = GX.toGx(raw);
  assert.deepEqual(GX.fromGx(JSON.parse(JSON.stringify(doc))), raw);
  const types = doc.relationships.map((r) => r.type);
  assert.equal(types.filter((t) => t === G + "Couple").length, 1);
  assert.equal(types.filter((t) => t === G + "ParentChild").length, 3); // B→C, A→C, A→D
  assert.equal(types.filter((t) => t === FT + "FamilyGroup").length, 2);
  const birth = doc.persons[0].facts[0];
  assert.equal(birth.type, G + "Birth");
  assert.deepEqual(birth.date, { original: "abt 1890", formal: "A+1890" });
  assert.equal(doc.persons[0].names[0].type, G + "BirthName");
  assert.equal(doc.persons[0].names[0].confidence, G + "High");
});

test("export: a valid, scoped GEDCOM X document with evidence, and no email addresses", async () => {
  const { call } = await fresh();
  const r = await call("GET", "/api/export.gedcomx?tree=all", { as: EDITOR });
  assert.equal(r.status, 200);
  assert.match(r.type, /application\/x-gedcomx-v1\+json/);
  const doc = r.data;
  assert.equal((await call("GET", "/api/export.gedcomx?tree=all", { as: MEMBER })).status, 403);
  const ids = new Set();
  const all = [...doc.persons, ...doc.relationships, ...doc.sourceDescriptions, ...doc.agents, ...doc.documents];
  for (const x of all) { assert.ok(!ids.has(x.id), `duplicate id ${x.id}`); ids.add(x.id); for (const n of [...(x.names || []), ...(x.facts || [])]) if (n.id) ids.add(`${x.id}/${n.id}`); }
  const refs = [];
  const walk = (x) => { if (Array.isArray(x)) return x.forEach(walk); if (x && typeof x === "object") { for (const [k, v] of Object.entries(x)) { if ((k === "resource" || k === "description") && typeof v === "string" && v.startsWith("#")) refs.push(v.slice(1)); else walk(v); } } };
  walk(doc);
  for (const ref of refs) assert.ok(ids.has(ref), `unresolved reference #${ref}`);
  assert.ok(doc.relationships.some((x) => x.type === G + "Couple") && doc.relationships.some((x) => x.type === G + "ParentChild"));
  for (const p of doc.persons.filter((x) => x[FT + "living"])) assert.equal(p.private, true, "living people are marked private");
  const persona = doc.persons.find((p) => p.extracted);
  assert.ok(persona, "findings are exported as record personas");
  assert.ok(doc.persons.some((p) => (p.evidence || []).some((e) => e.resource === `#${persona.id}`)), "the conclusion person points at the persona as evidence");
  assert.ok(doc.documents.some((d) => d.type === G + "Analysis"));
  assert.ok(!JSON.stringify(doc).includes("@example.test"));
});

test("the storage upgrade: dry run first, then the same tree on relationships", async () => {
  const { env, call } = await fresh();
  const before = shape(await tree(call));
  let r = await call("POST", "/api/admin/storage", { body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.data.report.dryRun, true);
  assert.equal(r.data.report.ok, true);
  assert.equal(r.data.mode, "working", "a dry run changes nothing");
  assert.equal((await call("POST", "/api/admin/storage", { as: EDITOR, body: { dry_run: false } })).status, 403);
  r = await call("POST", "/api/admin/storage", { body: { dry_run: false } });
  assert.equal(r.data.mode, "gedcomx");
  assert.ok(r.data.report.relationshipTypes.Couple > 0 && r.data.report.relationshipTypes.ParentChild > 0);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM families").first()).n, 0);
  const person = JSON.parse((await env.DB.prepare("SELECT data FROM people LIMIT 1").first()).data);
  assert.ok(Array.isArray(person.facts) && Array.isArray(person.names[0].nameForms), "people are stored as GEDCOM X Persons");
  assert.deepEqual(shape(await tree(call)), before, "the tree reads back exactly the same");
  assert.equal((await call("POST", "/api/admin/storage", { body: { dry_run: false } })).data.report.already, true);
});

test("on relationships: family edits write relationships; undo and conflicts still work", async () => {
  const { env, call } = await fresh();
  await call("POST", "/api/admin/storage", { body: { dry_run: false } });
  const t0 = await tree(call);
  const fam = Object.values(t0.families).find((f) => f.husband && f.wife);
  // a new child in an existing couple: two ParentChild rows
  let r = await call("POST", "/api/edit", { as: EDITOR, body: { tree: "all", reason: "baptism register", ops: [
    { op: "person.create", id: "$k", names: [{ given: "Kit", surname: "Example" }], sex: "F", events: [{ type: "Birth", date: "1960" }] },
    { op: "family.add_child", family: fam.id, person: "$k" }] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const kid = r.data.created.$k;
  const pcs = (await env.DB.prepare("SELECT * FROM relationships WHERE family = ? AND person2 = ?").bind(fam.id, kid).all()).results;
  assert.deepEqual(pcs.map((x) => x.type).sort(), [G + "ParentChild", G + "ParentChild"]);
  assert.deepEqual(pcs.map((x) => x.person1).sort(), [fam.husband, fam.wife].sort());
  const t1 = await tree(call);
  assert.ok(t1.families[fam.id].children.includes(kid) && t1.people[kid].famc.includes(fam.id));
  // a single parent's family: an ft:FamilyGroup holding the known parent
  r = await call("POST", "/api/edit", { as: EDITOR, body: { tree: "all", reason: "a record names only the mother", ops: [
    { op: "person.create", id: "$m", names: [{ given: "Mo", surname: "Example" }], sex: "F" },
    { op: "family.create", id: "$f", wife: "$m", children: [kid] }] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const groupFam = r.data.created.$f;
  const grp = (await env.DB.prepare("SELECT type FROM relationships WHERE family = ? AND type = ?").bind(groupFam, FT + "FamilyGroup").all()).results;
  assert.equal(grp.length, 1);
  // undo restores the relationships exactly
  const rv = await call("POST", `/api/changes/${r.data.batch}/revert?tree=all`, { as: EDITOR });
  assert.equal(rv.status, 200, JSON.stringify(rv.data));
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM relationships WHERE family = ?").bind(groupFam).first()).n, 0);
  assert.deepEqual(shape(await tree(call)), shape(t1));
  // a write against a stale family is refused: change it behind the app's back, then edit with the old view loaded
  const Store = await import("../worker/store.js");
  const { state, versions, mode } = await Store.loadEditable(env);
  await env.DB.prepare("UPDATE relationships SET version = version + 1 WHERE family = ?").bind(fam.id).run();
  const { applyOps } = await import("../worker/ops.js");
  const res = applyOps(state, [{ op: "family.remove_child", family: fam.id, person: kid }], { actor: EDITOR });
  await assert.rejects(env.DB.batch(Store.commitStatements(env, { touched: res.touched, versions, state: res.state, actor: EDITOR, actorKind: "person", reason: "x", batchId: "bstale", mode })), /_guard/);
});

test("import: our own export round-trips into an empty tree", async () => {
  const { call } = await fresh();
  const doc = (await call("GET", "/api/export.gedcomx?tree=all")).data;
  const src = shape(await tree(call));
  const b = await fresh({ seed: false });
  const r = await b.call("POST", "/api/admin/import.gedcomx", { body: doc });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const got = shape(await tree(b.call));
  assert.deepEqual(Object.keys(got.people).sort(), Object.keys(src.people).sort(), "persons, not record personas");
  assert.deepEqual(got.families, src.families, "the same families, rebuilt from relationships");
  for (const id of Object.keys(src.people)) assert.deepEqual(got.people[id].names, src.people[id].names);
  assert.equal((await b.call("POST", "/api/admin/import.gedcomx", { body: doc })).status, 409, "never over an existing tree");
});

test("import: a file from another GEDCOM X app (no family grouping, gender, full-text names)", async () => {
  const doc = {
    persons: [
      { id: "p1", gender: { type: G + "Male" }, names: [{ nameForms: [{ fullText: "Olaf Example" }] }], facts: [{ type: G + "MilitaryService", date: { original: "1917" } }] },
      { id: "p2", gender: { type: G + "Female" }, names: [{ nameForms: [{ fullText: "Ida Example", parts: [{ type: G + "Given", value: "Ida" }, { type: G + "Surname", value: "Example" }] }] }] },
      { id: "p3", gender: { type: G + "Female" }, names: [{ nameForms: [{ fullText: "Una Example" }] }] },
      { id: "p4", names: [{ nameForms: [{ fullText: "Val Example" }] }] },
    ],
    relationships: [
      { id: "r1", type: G + "Couple", person1: { resource: "#p1" }, person2: { resource: "#p2" }, facts: [{ type: G + "Marriage", date: { original: "1915" } }] },
      { id: "r2", type: G + "ParentChild", person1: { resource: "#p1" }, person2: { resource: "#p3" } },
      { id: "r3", type: G + "ParentChild", person1: { resource: "#p2" }, person2: { resource: "#p3" } },
      { id: "r4", type: G + "ParentChild", person1: { resource: "#p2" }, person2: { resource: "#p4" } },
    ],
  };
  const { call } = await fresh({ seed: false });
  assert.equal((await call("POST", "/api/admin/import.gedcomx", { body: doc })).status, 201);
  const t = await tree(call);
  assert.ok(t.families && t.families.r1, JSON.stringify(t).slice(0, 600));
  assert.deepEqual([t.families.r1.husband, t.families.r1.wife, t.families.r1.children], ["p1", "p2", ["p3"]]);
  const solo = Object.values(t.families).find((f) => f.children.includes("p4"));
  assert.equal(solo.wife, "p2", "a one-parent child goes to that parent's own family, placed by gender");
  assert.equal(t.people.p1.events[0].type, "Military");
  assert.equal(t.people.p1.names[0].given, "Olaf");
  assert.equal(t.people.p1.sex, "M");
});
