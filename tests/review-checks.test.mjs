// Rules added after a full review of a real tree: who counts as living when they have no dates, siblings in a
// family with no parent recorded, five data checks, and findings an edit settles on its own.
// Fictional people only.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { derive } from "../worker/derive.js";
import { makeEnv, migrate } from "./helpers/fake-env.mjs";
import { applyAndCommit, revertBatch } from "../worker/store.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const person = (id, given, surname, sex, { famc = [], fams = [], events = [] } = {}) =>
  ({ id, names: [{ given, surname, suffix: "", type: "" }], sex, famc, fams, events, notes: [], citations: [], media: [] });
const family = (id, husband, wife, children, events = []) => ({ id, husband, wife, children, events });
const born = (date, extra = {}) => ({ type: "Birth", date, ...extra });

function run(people, families, { sources = {}, research = {} } = {}) {
  const P = Object.fromEntries(people.map((p) => [p.id, p]));
  const F = Object.fromEntries(families.map((f) => [f.id, f]));
  return derive({ raw: { people: P, families: F, sources, media: {} }, research: { home_person: people[0].id, ...research } }, { today: "2026-01-01" });
}
const kinds = (b, pid) => b.issues.filter((i) => i.person === pid).map((i) => i.kind);

test("an undated person is living when close relatives put their birth within the last 100 years", () => {
  const b = run([
    person("H", "Example", "Sample", "M", { famc: ["F1"], events: [born("1990")] }),
    person("FA", "Older", "Sample", "M", { fams: ["F1"], famc: ["F0"], events: [born("1960")] }),
    person("SIB", "Undated", "Sample", "F", { famc: ["F0"] }),          // sibling of a 1960 birth
    person("KID", "Undated", "Sample", "M", { famc: ["F2"] }),          // child of an undated parent, two steps away
    person("P2", "Undated", "Sample", "M", { famc: ["F0"], fams: ["F2"] }),
    person("OLD", "Undated", "Elder", "F", { fams: ["F3"] }),           // mother of a child born 1890
    person("C90", "Early", "Elder", "M", { famc: ["F3"], events: [born("1890")] }),
    person("OVR", "Undated", "Sample", "F", { famc: ["F0"] }),          // override wins
  ], [family("F0", null, null, ["FA", "SIB", "P2", "OVR"]), family("F1", "FA", null, ["H"]), family("F2", "P2", null, ["KID"]), family("F3", null, "OLD", ["C90"])],
  { research: { overrides: { OVR: { living: false } } } });
  assert.equal(b.people.SIB.living, true);
  assert.equal(b.people.P2.living, true);
  assert.equal(b.people.KID.living, true, "estimates carry over more than one step");
  assert.equal(b.people.OLD.living, false);
  assert.equal(b.people.OVR.living, false);
});

test("children of a family with no parent recorded are still siblings", () => {
  const b = run([
    person("H", "Example", "Sample", "M", { famc: ["F1"], events: [born("1990")] }),
    person("FA", "Father", "Sample", "M", { famc: ["F0"], fams: ["F1"], events: [born("1960")] }),
    person("UN", "Uncle", "Sample", "M", { famc: ["F0"], events: [born("1962")] }),
  ], [family("F0", null, null, ["FA", "UN"]), family("F1", "FA", null, ["H"])]);
  assert.equal(b.people.UN.relation, "uncle");
  assert.equal(b.people.FA.relation, "father");
  assert.equal(b.people.UN.direct, false);
});

test("new data checks", () => {
  const sources = { S1: { id: "S1", title: "1950 United States Federal Census" }, S2: { id: "S2", title: "Example County Census, 1900-1950" } };
  const b = run([
    person("H", "Example", "Sample", "M", { famc: ["F1"], events: [born("1990")] }),
    person("FA", "Father", "Sample", "M", { fams: ["F1", "F2"], events: [born("1950"),
      { type: "Occupation", date: "abt 1960", citations: [{ source: "S1" }] },           // dated after the census it cites
      { type: "Residence", date: "1965", citations: [{ source: "S2" }] }] }),            // a range: not checked
    person("MO", "Mother", "Sample", "F", { fams: ["F1"], events: [born("1952")] }),  // only her husband's surname
    person("MO2", "Mother", "Other", "F", { fams: ["F2"], famc: ["F9"], events: [born("1952")] }),
    person("GF", "Grandfather", "Other", "M", { fams: ["F9"], events: [born("1920"), { type: "Death", date: "1980" }, { type: "Death", date: "1981" },
      { type: "Residence", date: "1910" }, { type: "Residence", date: "1990" }] }),
    person("K2", "Child", "Sample", "F", { famc: ["F3"], events: [born("1985")] }),
  ], [family("F1", "FA", "MO", ["H"]), family("F2", "FA", "MO2", []), family("F3", "FA", null, ["K2"]), family("F9", "GF", null, ["MO2"])],
  { sources });
  assert.ok(kinds(b, "FA").includes("cited-after-record"));
  assert.equal(kinds(b, "FA").filter((k) => k === "cited-after-record").length, 1, "a census range is not checked");
  assert.ok(kinds(b, "MO").includes("married-surname"));
  assert.ok(!kinds(b, "MO2").includes("married-surname"), "a different surname is not flagged");
  assert.deepEqual(kinds(b, "GF").filter((k) => k === "event-outside-life").length, 2);
  assert.ok(kinds(b, "GF").includes("duplicate-event"));
  const b2 = run([
    person("H", "Example", "Sample", "M", { famc: ["F1"], events: [born("1990")] }),
    person("FA", "Father", "Sample", "M", { fams: ["F1", "F3"], events: [born("1950")] }),
    person("MO", "Mother", "Lane", "F", { fams: ["F1"], events: [born("1952")] }),
    person("K2", "Child", "Sample", "F", { famc: ["F3"], events: [born("1985")] }),
  ], [family("F1", "FA", "MO", ["H"]), family("F3", "FA", null, ["K2"])]);
  assert.ok(kinds(b2, "FA").includes("one-parent-family"));
});

// ---- findings settled by an edit (on the fictional example family)
let env;
before(() => {
  const dir = mkdtempSync(join(tmpdir(), "ft-review-"));
  execFileSync("python3", ["tools/build.py", "--data", "example", "--out", dir, "--raw-out", join(dir, "raw.json")], { cwd: ROOT });
  const research = JSON.parse(readFileSync(join(ROOT, "example/research.json"), "utf8"));
  research.findings = [];
  writeFileSync(join(dir, "research.json"), JSON.stringify(research));
  execFileSync("python3", ["tools/seed_app.py", "--raw", join(dir, "raw.json"), "--bundle", join(dir, "family.json"), "--research", join(dir, "research.json"), "--out", join(dir, "seed.sql"), "--owner", "owner@example.test", "--cutover"], { cwd: ROOT });
  env = makeEnv();
  migrate(env.DB, ROOT);
  env.DB.execFile(join(dir, "seed.sql"));
});
const addFinding = (data) => Number(env.DB.db.prepare("INSERT INTO findings (person_id, data, created_at, created_by) VALUES (?, ?, ?, ?)").run(data.person, JSON.stringify({ kind: "data-error", confidence: "high", ...data }), "2026-01-01", "test").lastInsertRowid);
const resolution = async (id) => JSON.parse((await env.DB.prepare("SELECT data FROM findings WHERE id = ?").bind(id).first()).data).resolution;
const meta = { actor: "owner@example.test", actorKind: "person", reason: "test" };

test("an edit closes the findings it settles, and undoing it reopens them", async () => {
  const sex = addFinding({ person: "I4", field: "sex", claim: "sex M", finding: "Recorded wrongly. Set sex to F." });
  const sexOther = addFinding({ person: "I4", field: "sex", claim: "sex M", finding: "Set sex to M." });
  const merge = addFinding({ person: "I15", field: "identity", claim: "Two Florence Pikes", finding: "I15 duplicates I9: same name, same death year. Merge them." });
  const famDel = addFinding({ person: "I17", field: "parents", claim: "Recorded twice with the same parents", finding: "Delete family F8, a duplicate of the same couple." });
  const famKeep = addFinding({ person: "I17", field: "parents", claim: "In F4 and F8", finding: "Keep F4 only; remove him from F8." });

  const r1 = await applyAndCommit(env, [{ op: "person.update", id: "I4", set: { sex: "F" } }], meta);
  assert.deepEqual(r1.settled, [sex]);
  assert.equal((await resolution(sex)).status, "resolved");
  assert.equal(await resolution(sexOther), undefined);

  const r2 = await applyAndCommit(env, [{ op: "family.delete", family: "F8" }, { op: "person.merge", keep: "I9", drop: "I15" }], meta);
  assert.deepEqual(r2.settled.sort(), [merge, famDel].sort());
  assert.equal(await resolution(famKeep), undefined, "names a family that wasn't deleted");
  // the merge re-files the finding under the surviving person; resolving it must not undo that
  assert.equal(JSON.parse((await env.DB.prepare("SELECT data FROM findings WHERE id = ?").bind(merge).first()).data).person, "I9");

  await revertBatch(env, r2.batchId, meta);
  assert.equal(await resolution(famDel), undefined);
  // undoing a merge brings the dropped person back and removes the alias (this used to fail with "changed since")
  assert.ok(await env.DB.prepare("SELECT 1 FROM people WHERE id = 'I15'").first());
  assert.equal(JSON.parse((await env.DB.prepare("SELECT value FROM config WHERE key = 'aliases'").first())?.value || "{}").I15, undefined);
  await revertBatch(env, r1.batchId, meta);
  assert.equal(await resolution(sex), undefined);
});
