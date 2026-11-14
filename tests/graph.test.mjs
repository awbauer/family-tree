// Graph queries (worker/graph.js) against the fictional example family.
//   node --test tests/
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndex, relationshipPath, ancestors, descendants, commonAncestors, components, explain } from "../worker/graph.js";
import { scopeBundle } from "../worker/scope.js";
import { relationLabels } from "../worker/derive.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let bundle;

before(() => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "graph-test-"));
  const r = spawnSync("python3", [path.join(ROOT, "tools/build.py"), "--data", path.join(ROOT, "example"), "--out", out],
    { encoding: "utf8" });
  assert.equal(r.status, 0, `build.py failed:\n${r.stdout}\n${r.stderr}`);
  bundle = JSON.parse(fs.readFileSync(path.join(out, "family.json"), "utf8"));
  fs.rmSync(out, { recursive: true, force: true });
});

const ids = (xs) => xs.map((x) => x.id).sort();
const pathIds = (p) => [p.steps[0]?.from, ...p.steps.map((s) => s.to)];

/** The example tree plus fictional extras: a 2nd cousin of Sam (I1) and one unconnected person. */
function extended() {
  const b = structuredClone(bundle);
  const person = (id, name, sex, famc, fams) =>
    (b.people[id] = { id, name, sex, branch: "hartley", living: false, famc, fams });
  b.families.FX1 = { id: "FX1", husband: "I17", wife: null, children: ["IX1"] };
  b.families.FX2 = { id: "FX2", husband: null, wife: "IX1", children: ["IX2"] };
  b.people.I17.fams = ["FX1"];
  person("IX1", "Mabel Hartley", "F", ["FX1"], ["FX2"]);
  person("IX2", "Peter Quill", "M", ["FX2"], []);
  person("IX9", "Nobody Elsewhere", "M", [], []);
  return b;
}

test("parent/child path", () => {
  const idx = buildIndex(bundle.people, bundle.families);
  const p = relationshipPath(idx, "I1", "I2");
  assert.equal(p.found, true);
  assert.deepEqual(p.steps, [{ from: "I1", to: "I2", rel: "father" }]);
  assert.equal(p.label, "father");
  assert.deepEqual(p.commonAncestors, ["I2"]);
  const back = relationshipPath(idx, "I3", "I1");
  assert.deepEqual(back.steps, [{ from: "I3", to: "I1", rel: "son" }]);
  assert.equal(explain(p, bundle.people), "Sam Hartley's father is Daniel James Hartley");
});

test("cousin path: label and common ancestors", () => {
  const b = extended();
  const idx = buildIndex(b.people, b.families);
  const p = relationshipPath(idx, "I1", "IX2");
  assert.equal(p.found, true);
  assert.equal(p.steps.length, 6);
  assert.ok(p.steps.every((s) => !["husband", "wife", "spouse"].includes(s.rel)));
  assert.equal(p.label, relationLabels(b.people, b.families, "I1").IX2.relation);
  assert.equal(p.label, "2nd cousin");
  assert.deepEqual(p.commonAncestors.sort(), ["I8", "I9"]);
  assert.deepEqual(commonAncestors(idx, "I1", "IX2"),
    [{ id: "I8", fromA: 3, fromB: 3 }, { id: "I9", fromA: 3, fromB: 3 }]);
  // grandfather George's brother Thomas: the sentence collapses parent+child into a sibling
  const u = relationshipPath(idx, "I1", "I17");
  assert.equal(u.label, "great-uncle");
  assert.match(explain(u, b.people), /George Hartley's brother is Thomas Hartley$/);
});

test("in-law path goes through a spouse", () => {
  const idx = buildIndex(bundle.people, bundle.families);
  const p = relationshipPath(idx, "I4", "I3");
  assert.deepEqual(p.steps.map((s) => s.rel), ["son", "wife"]);
  assert.deepEqual(pathIds(p), ["I4", "I2", "I3"]);
  assert.equal(p.label, "wife of son");
  assert.deepEqual(p.commonAncestors, []);
  assert.equal(explain(p, bundle.people), "George Hartley's son is Daniel James Hartley; Daniel James Hartley's wife is Ana Maria Costa");
  const q = relationshipPath(idx, "I12", "I2");
  assert.deepEqual(q.steps.map((s) => s.rel), ["son", "daughter", "husband"]);
  assert.equal(q.label, "husband of granddaughter");
});

test("blood links win ties over spouse links", () => {
  // Florence Pike (I9) -> Arthur's second wife (I15): via Arthur (husband, wife) or via Thomas (son, mother)
  const idx = buildIndex(bundle.people, bundle.families);
  const p = relationshipPath(idx, "I9", "I15");
  assert.deepEqual(p.steps.map((s) => s.rel), ["son", "mother"]);
});

test("no path between disconnected people; maxDepth", () => {
  const b = extended();
  const idx = buildIndex(b.people, b.families);
  assert.deepEqual(relationshipPath(idx, "I1", "IX9"), { found: false });
  assert.deepEqual(relationshipPath(idx, "I1", "NOPE"), { found: false });
  assert.deepEqual(relationshipPath(idx, "I1", "IX2", { maxDepth: 5 }), { found: false });
  assert.equal(explain({ found: false }, b.people), "No relationship path found.");
});

test("ancestors and descendants with generation numbers", () => {
  const idx = buildIndex(bundle.people, bundle.families);
  const anc = ancestors(idx, "I1");
  assert.equal(anc.length, 13); // 8 great-grandparent slots, one unknown (F6 has no wife)
  const g = Object.fromEntries(anc.map((x) => [x.id, x.generation]));
  assert.equal(g.I2, 1); assert.equal(g.I3, 1);
  assert.equal(g.I4, 2); assert.equal(g.I7, 2);
  assert.equal(g.I8, 3); assert.equal(g.I14, 3);
  assert.deepEqual(ids(ancestors(idx, "I1", 1)), ["I2", "I3"]);
  const desc = descendants(idx, "I8");
  assert.deepEqual(Object.fromEntries(desc.map((x) => [x.id, x.generation])), { I17: 1, I4: 1, I2: 2, I16: 3, I1: 3 });
  assert.deepEqual(ids(descendants(idx, "I8", 2)), ["I17", "I2", "I4"]);
  assert.deepEqual(descendants(idx, "I1"), []);
});

test("components: the main tree and the unconnected", () => {
  assert.equal(components(buildIndex(bundle.people, bundle.families)).length, 1);
  const b = extended();
  const comps = components(buildIndex(b.people, b.families));
  assert.equal(comps.length, 2);
  assert.equal(comps[0].length, 20);
  assert.deepEqual(comps[1], ["IX9"]);
});

test("scope: graph over a scoped bundle never leaves the scope", () => {
  // one branch, plus one Costa great-grandfather whose only links run through the hidden home family
  const tree = { id: "t1", name: "Hartleys", definition: { branches: ["hartley"], include: ["I12"] } };
  const scoped = scopeBundle(bundle, { tree, view: {}, helpers: { relationLabels } });
  const visible = new Set(Object.keys(scoped.people));
  assert.deepEqual([...visible].sort(), ["I12", "I15", "I17", "I4", "I8", "I9"]);
  const hidden = Object.keys(bundle.people).filter((id) => !visible.has(id));

  const full = buildIndex(bundle.people, bundle.families);
  assert.equal(relationshipPath(full, "I4", "I12").found, true); // through hidden people in the full tree

  const idx = buildIndex(scoped.people, scoped.families);
  const results = {
    cut: relationshipPath(idx, "I4", "I12"),
    toHidden: relationshipPath(idx, "I4", "I1"),
    inside: relationshipPath(idx, "I4", "I17"),
    insideInLaw: relationshipPath(idx, "I4", "I15"),
    anc: ancestors(idx, "I4"),
    desc: descendants(idx, "I4"),
    common: commonAncestors(idx, "I4", "I17"),
    comps: components(idx),
  };
  results.sentences = [explain(results.inside, scoped.people), explain(results.insideInLaw, scoped.people)];
  assert.deepEqual(results.cut, { found: false });
  assert.deepEqual(results.toHidden, { found: false });
  assert.equal(results.inside.found, true);
  assert.equal(results.inside.label, "brother");
  assert.deepEqual(results.desc, []);
  assert.deepEqual(ids(results.anc), ["I8", "I9"]);
  assert.deepEqual(results.comps.map((c) => c.length), [5, 1]);
  for (const k of ["parents", "children", "spouses"]) {
    for (const [id, ys] of idx[k]) assert.ok(visible.has(id) && ys.every((y) => visible.has(y)), `${k} edge leaves scope`);
  }

  const json = JSON.stringify(results);
  for (const id of hidden) assert.ok(!new RegExp(`\\b${id}\\b`).test(json), `hidden ID ${id} in graph output`);
  for (const id of hidden) assert.ok(!json.includes(bundle.people[id].name), `hidden name in graph output`);
});
