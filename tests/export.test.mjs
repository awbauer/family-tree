// GEDCOM export: worker/gedcom_export.js must produce a file that tools/gedcom_to_json.py reads back with the
// same people, families, sources, names and events. Uses only the fictional family in example/.
//   node --test tests/export.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exportGedcom } from "../worker/gedcom_export.js";
import { scopeBundle } from "../worker/scope.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOW = new Date("2026-11-14T12:34:56Z");

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), "ged-export-")); }

function buildExample() {
  const out = tmpdir();
  const r = spawnSync("python3", [path.join(ROOT, "tools/build.py"), "--data", path.join(ROOT, "example"), "--out", out], { encoding: "utf8" });
  assert.equal(r.status, 0, `build.py failed:\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(fs.readFileSync(path.join(out, "family.json"), "utf8"));
}

/** Write the .ged to a temp file and parse it with tools/gedcom_to_json.parse. */
function reparse(ged) {
  const file = path.join(tmpdir(), "export.ged");
  fs.writeFileSync(file, ged, "utf8");
  const code = "import json, sys; sys.path.insert(0, sys.argv[1]); import gedcom_to_json as g; "
    + "print(json.dumps(g.parse(sys.argv[2]), ensure_ascii=False))";
  const r = spawnSync("python3", ["-c", code, path.join(ROOT, "tools"), file], { encoding: "utf8" });
  assert.equal(r.status, 0, `parse failed:\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** Lines of one level-0 record, by xref. */
function record(ged, xref) {
  const lines = ged.split("\r\n");
  const start = lines.findIndex((l) => l.startsWith(`0 @${xref}@ `));
  assert.ok(start >= 0, `record ${xref} not found`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith("0 "));
  return lines.slice(start, end);
}

const evKey = (e) => JSON.stringify([e.type, e.date || "", e.place || ""]);
const nameKey = (n) => JSON.stringify([n.given || "", n.surname || "", n.suffix || "", n.type || ""]);

test("example family round-trips through GEDCOM", () => {
  const bundle = buildExample();
  const ged = exportGedcom(bundle, { title: "Example family", now: NOW });

  // structure
  assert.ok(ged.startsWith("0 HEAD\r\n"));
  assert.ok(ged.endsWith("0 TRLR\r\n"));
  assert.ok(!/[^\r]\n/.test(ged), "every line ends with CRLF");
  for (const l of ["1 SOUR family-tree", "2 VERS 5.5.1", "2 FORM LINEAGE-LINKED", "1 CHAR UTF-8", "1 DATE 14 NOV 2026"]) {
    assert.ok(ged.includes(`\r\n${l}\r\n`), `HEAD has ${l}`);
  }
  assert.match(ged, /\r\n0 @SUBM\d+@ SUBM\r\n1 NAME Example family\r\n/);
  for (const l of ged.split("\r\n").filter(Boolean)) assert.ok(l.length <= 255, `line too long: ${l.length}`);

  const back = reparse(ged);
  assert.equal(Object.keys(back.people).length, Object.keys(bundle.people).length);
  assert.equal(Object.keys(back.families).length, Object.keys(bundle.families).length);
  assert.equal(Object.keys(back.sources).length, Object.keys(bundle.sources).length);
  assert.ok(Object.keys(bundle.people).length > 10, "example family is non-trivial");

  for (const [id, p] of Object.entries(bundle.people)) {
    const q = back.people[id];
    assert.ok(q, `person ${id} missing`);
    assert.deepEqual(q.names.map(nameKey), p.names.map(nameKey), `${id} names`);
    assert.equal(q.sex, p.sex, `${id} sex`);
    assert.deepEqual(q.events.map(evKey), p.events.map(evKey), `${id} events`);
    assert.deepEqual(q.famc, p.famc, `${id} famc`);
    assert.deepEqual(q.fams, p.fams, `${id} fams`);
    assert.deepEqual(q.notes, p.notes, `${id} notes`);
    for (const [i, e] of p.events.entries()) {
      for (const k of ["value", "note", "age"]) assert.equal(q.events[i][k], e[k], `${id} event ${i} ${k}`);
      const cites = (c) => (c || []).map((x) => [x.source, x.page || "", x.note || ""]);
      assert.deepEqual(cites(q.events[i].citations), cites(e.citations), `${id} event ${i} citations`);
    }
  }
  for (const [id, f] of Object.entries(bundle.families)) {
    const q = back.families[id];
    assert.ok(q, `family ${id} missing`);
    assert.equal(q.husband, f.husband || null);
    assert.equal(q.wife, f.wife || null);
    assert.deepEqual(q.children, f.children);
    assert.deepEqual(q.events.map(evKey), f.events.map(evKey), `${id} events`);
  }
  for (const [id, s] of Object.entries(bundle.sources)) assert.equal(back.sources[id].title, s.title);
});

test("a private (names-only) person exports only NAME, SEX and family links", () => {
  const full = buildExample();
  const scoped = scopeBundle(full, { tree: { id: "t", name: "T", definition: { branches: ["*"] } }, view: { living: "names-only" }, isOwner: true });
  const priv = Object.values(scoped.people).filter((p) => p.private);
  assert.ok(priv.length > 0, "example has living people");
  const withEvents = priv.find((p) => full.people[p.id].events.length > 0);
  assert.ok(withEvents, "a private person had events before scoping");

  const ged = exportGedcom(scoped, { now: NOW });
  for (const p of priv) {
    const rec = record(ged, p.id);
    const tags = rec.slice(1).map((l) => l.split(" ")[1]);
    const allowed = new Set(["NAME", "GIVN", "SURN", "NSFX", "TYPE", "SEX", "FAMC", "FAMS"]);
    for (const t of tags) assert.ok(allowed.has(t), `${p.id} has ${t}`);
    assert.ok(tags.includes("NAME"));
    // nothing of the original events leaks into the record
    for (const e of full.people[p.id].events) if (e.date) assert.ok(!rec.join("\n").includes(e.date), `${p.id} leaks a date`);
  }
  const back = reparse(ged);
  assert.equal(back.people[withEvents.id].events.length, 0);
  assert.equal(back.people[withEvents.id].names[0].surname, withEvents.names[0].surname);
});

test("long values wrap with CONC/CONT and '@' is escaped", () => {
  const long = "word ".repeat(150).trim() + " end"; // ~750 chars, one line
  const multi = "first line\nsecond line has an @ sign\n\nfourth after a blank";
  const unbroken = "x".repeat(600);
  const bundle = {
    people: {
      I1: { id: "I1", names: [{ given: "Test", surname: "Person@Home" }], sex: "F", famc: [], fams: [], citations: [], media: [],
        notes: [long, multi, unbroken],
        events: [{ type: "Birth", date: "1 Jan 1900", place: "Somewhere", note: "email a@b.example" },
          { type: "Custom thing", date: "1901", value: "a value" }, { type: "Death" }] },
    },
    families: {}, sources: {}, media: {},
  };
  const ged = exportGedcom(bundle, { now: NOW });
  const lines = ged.split("\r\n").filter(Boolean);
  for (const l of lines) {
    assert.ok(l.length <= 255, `line too long: ${l.length}`);
    const value = l.replace(/^\d+ (@[^@]+@ )?\S+ ?/, "");
    if (!/^@[^@]+@$/.test(value)) assert.ok(!/(^|[^@])@([^@]|$)/.test(value.replace(/@@/g, "")), `unescaped @ in: ${l}`);
  }
  assert.ok(lines.some((l) => / CONC /.test(l)), "has CONC");
  assert.ok(lines.some((l) => / CONT /.test(l)), "has CONT");
  assert.ok(lines.includes("2 CONT"), "blank line kept as an empty CONT");
  assert.ok(ged.includes("1 NAME Test /Person@@Home/\r\n"));
  assert.ok(ged.includes("2 NOTE email a@@b.example\r\n"));
  assert.ok(ged.includes("1 EVEN a value\r\n2 TYPE Custom thing\r\n2 DATE 1901\r\n"));
  assert.ok(ged.includes("1 DEAT Y\r\n"));
  for (const l of lines.filter((x) => / CONC /.test(x))) {
    const v = l.slice(l.indexOf("CONC ") + 5);
    assert.ok(!/^\s|\s$/.test(v), "CONC chunks do not start or end with a space");
  }

  const back = reparse(ged).people.I1;
  const unesc = (s) => s.replace(/@@/g, "@"); // gedcom_to_json.py does not un-escape '@@'
  assert.deepEqual(back.notes.map(unesc), [long, multi, unbroken]);
  assert.equal(unesc(back.names[0].surname), "Person@Home");
  assert.deepEqual(back.events.map((e) => e.type), ["Birth", "Custom thing", "Death"]);
  assert.equal(back.events[1].value, "a value");
});
