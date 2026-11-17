// Search across names (with variants), facts, citations, stories, findings, to-dos and sources. Fictional data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIndex, dmSoundex, distance, fold, search, terms } from "../worker/textsearch.ts";

test("Daitch–Mokotoff codes match the published values, including names with two codes", () => {
  const want = { AUERBACH: ["097400", "097500"], LIPSHITZ: ["874400"], LEWINSKY: ["876450"], LEVINSKI: ["876450"],
    SZLAMAWICZ: ["486740"], SHLAMOVITZ: ["486740"], PETERS: ["734000", "739400"], MOSKOWITZ: ["645740"] };
  for (const [w, codes] of Object.entries(want)) assert.deepEqual(dmSoundex(w).sort(), codes, w);
  assert.deepEqual(dmSoundex("Nováková"), dmSoundex("Novakova"));
  assert.deepEqual(dmSoundex("123"), []);
});

test("folding, distance and terms", () => {
  assert.equal(fold("Ærøskøbing Straße Łódź"), "aeroskobing strasse lodz");
  assert.equal(distance("hartley", "hartly"), 1);
  assert.equal(distance("abcdef", "badcfe", 2), 3);
  assert.deepEqual(terms(`mill "Leeds Road" 1931`), ["mill", "leeds road", "1931"]);
});

const tree = {
  people: {
    I1: { id: "I1", name: "Walter Hartley", names: [{ given: "Walter", surname: "Hartley" }, { given: "Wally", surname: "Hartly" }],
      events: [{ type: "Occupation", value: "Weaver at a woollen mill", place: "Bradford, Yorkshire", citations: [{ title: "1921 census", text: "Walter Hartley, weaver, Ivy Mill" }] }],
      notes: ["Played cornet in the colliery band."] },
    I2: { id: "I2", name: "Eva Nováková", names: [{ given: "Eva", surname: "Nováková" }], events: [{ type: "Birth", date: "1925", place: "Plzeň" }] },
    I3: { id: "I3", name: "Josef Novak", names: [{ given: "Josef", surname: "Novak" }], events: [] },
    I4: { id: "I4", name: "Rosa Kovacs", names: [{ given: "Rosa", surname: "Kovacs" }], events: [] },
    I5: { id: "I5", name: "Hidden Person", private: true, names: [{ given: "Hidden", surname: "Person" }], events: [{ type: "Birth", place: "Secretville" }] },
  },
  families: { F1: { id: "F1", husband: "I3", wife: "I2", children: [], events: [{ type: "Marriage", place: "Plzeň", note: "Married in the town hall" }] } },
  sources: { S1: { title: "Bradford parish registers", note: "Baptisms 1880–1920" } },
  research: {
    stories: [{ slug: "band", title: "The colliery band", people: ["I1"], body: "[[I1|Walter]] carried his cornet to every **gala**." }],
    findings: [{ id: 7, person: "I2", claim: "b. 1925 Plzeň", finding: "Baptism register entry seen", sources: [{ title: "Plzeň baptisms", page: "f. 12" }] }],
    todo: [{ id: 3, person: "I4", task: "Find Rosa's arrival manifest", where: "Ellis Island passenger lists" }],
  },
};
const ix = buildIndex(tree);
const ids = (q, o) => search(ix, q, o).map((h) => `${h.kind}:${h.id}`);

test("names: accents ignored, alternate names, sound-alikes and close spellings, each labelled", () => {
  assert.deepEqual(ids("novak", { kinds: ["person"] }).sort(), ["person:I2", "person:I3"]);
  assert.deepEqual(ids("hartly", { kinds: ["person"] }), ["person:I1"]); // an alternate name, exactly
  const kov = search(ix, "Kovach", { kinds: ["person"] });
  assert.equal(kov[0].id, "I4");
  assert.equal(kov[0].matches[0].how, "sounds");
  const close = search(ix, "Hartlee", { kinds: ["person"] });
  assert.equal(close[0].id, "I1");
  assert.notEqual(close[0].matches[0].how, "exact");
  assert.deepEqual(ids("Kovach", { kinds: ["person"], variants: false }), []);
});

test("facts, notes, citations and family events are searched; every term must match the same record", () => {
  assert.deepEqual(ids("cornet").sort(), ["person:I1", "story:band"]);
  assert.deepEqual(ids("ivy mill"), ["person:I1"]); // the second word is in a citation
  assert.deepEqual(ids("town hall"), ["person:I2", "person:I3"]); // a marriage reaches both spouses
  assert.deepEqual(ids(`"woollen mill" bradford`), ["person:I1"]);
  assert.deepEqual(ids("cornet plzen"), []);
});

test("stories, findings, to-dos and sources come back with a snippet of what matched", () => {
  assert.deepEqual(ids("gala"), ["story:band"]); // markup stripped
  const f = search(ix, "baptism register").find((h) => h.kind === "finding");
  assert.equal(`${f.kind}:${f.id}:${f.person}`, "finding:7:I2");
  assert.ok(f.matches.some((m) => m.snippet.includes("Baptism register")));
  assert.deepEqual(ids("manifest ellis"), ["todo:3"]);
  assert.deepEqual(ids("parish registers"), ["source:S1"]);
});

test("a private person is found by name only, and nothing else about them is indexed", () => {
  assert.deepEqual(ids("hidden person"), ["person:I5"]);
  assert.equal(search(ix, "hidden")[0].private, true);
  assert.deepEqual(ids("secretville"), []);
});

test("a record that mentions the word beats a name that only sounds like it", () => {
  const t = buildIndex({ people: { A: { id: "A", name: "Anna Kovacs", names: [], events: [] },
    B: { id: "B", name: "Ben Lee", names: [], events: [{ type: "Immigration", note: "Arrived on the Kovach" }] } }, families: {}, research: {} });
  assert.deepEqual(search(t, "kovach").map((h) => h.id), ["B", "A"]);
});

test("names rank above passing mentions", () => {
  const t = buildIndex({ people: { A: { id: "A", name: "Mary Weaver", names: [], events: [] }, ...tree.people }, families: {}, research: {} });
  assert.equal(search(t, "weaver")[0].id, "A");
});
