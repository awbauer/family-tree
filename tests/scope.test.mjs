// worker/scope.js and living relatives: research covers living relatives like anyone else, so a view that reduces
// the living to names (names-only) or to "Living <surname>" (anonymous) must also drop everything research has
// gathered about them, and an anonymous view must scrub their real name from any text that survives. A full view
// keeps all of it. A small invented family only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeBundle } from "../worker/scope.js";

const TREE = { id: "t", name: "Everyone", definition: { branches: ["*"] } };
const ROBIN = "Robin Exampleby"; // I3, living

/** Walter (I1, died) and Mabel (I2, died), and their living son Robin (I3), with research about all of them. */
function fixture() {
  const person = (id, given, sex, more = {}) => ({ id, name: `${given} Exampleby`, given, surname: "Exampleby", sex, branch: "x",
    names: [{ given, surname: "Exampleby" }], famc: [], fams: [], events: [], notes: [], media: [], citations: [], ...more });
  return {
    generated: "2026-01-01", home: "I1",
    people: {
      I1: person("I1", "Walter", "M", { fams: ["F1"], birth: { year: 1900 }, death: { year: 1970 },
        events: [{ fid: "e1", type: "Birth", date: "1900" }, { fid: "e2", type: "Death", date: "1970" }],
        profile: { text: `Walter Exampleby (1900–1970) married Mabel Exampleby. Their son ${ROBIN} (living) survives him.` } }),
      I2: person("I2", "Mabel", "F", { fams: ["F1"], birth: { year: 1903 }, death: { year: 1985 },
        events: [{ fid: "e1", type: "Birth", date: "1903" }, { fid: "e2", type: "Death", date: "1985" }] }),
      I3: person("I3", "Robin", "M", { living: true, famc: ["F1"], birth: { year: 1960 },
        events: [{ fid: "e1", type: "Birth", date: "1960", place: "Exampleton" }, { fid: "e2", type: "Residence", date: "1995" }],
        notes: ["Robin's own note."], profile: { text: "Robin Exampleby, born 1960 in Exampleton, a profile of a living relative." } }),
    },
    families: { F1: { id: "F1", husband: "I1", wife: "I2", children: ["I3"], events: [] } },
    sources: {}, media: {}, issues: [], aliases: {},
    research: {
      branches: [{ key: "x", name: "Exampleby" }],
      findings: [
        { id: "f-robin", person: "I3", kind: "confirmed", finding: "A birth notice for Robin in 1960.", confidence: "high" },
        { id: "f-walter", person: "I1", kind: "confirmed", finding: `Walter's obituary names his son ${ROBIN} as a mourner.`, confidence: "medium" },
      ],
      todo: [{ id: "t-robin", person: "I3", task: "Find Robin's school records" }, { id: "t-walter", person: "I1", task: "Find Walter's will" }],
      todo_done: [{ id: "d-robin", person: "I3", task: "Robin's marriage notice" }, { id: "d-walter", person: "I1", task: "Walter's burial" }],
      research_log: [
        { person: "I3", searched: "Example Gazette, birth notices, 1960", result: "found" },
        { person: "I1", searched: "Example Gazette, obituaries, 1970", result: "found" },
        { searched: `Example directories, Exampleby households (incl. ${ROBIN})`, result: "nil" },
      ],
      people_status: { I3: { status: "partly-verified", note: "birth notice" }, I1: { status: "verified", note: "obituary" } },
      stories: [
        { slug: "about-robin", title: "Robin", people: ["I3"], body: `[[I3|${ROBIN}]] was born in 1960.` },
        { slug: "links-robin", title: "Walter and son", people: ["I1"], body: `[[I1|Walter Exampleby]] and his son [[I3|${ROBIN}]].` },
        { slug: "bare-link", title: "Walter, bare link", people: ["I1"], body: "[[I1|Walter Exampleby]] and his son [[I3]]." },
        { slug: "walter", title: "Walter", people: ["I1"], body: `[[I1|Walter Exampleby]] died in 1970, mourned by his son ${ROBIN}.` },
      ],
      media: { I3: [{ file: "robin.jpg", title: "Robin at school" }], I1: [{ file: "walter.jpg", title: "Walter" }] },
    },
  };
}

const scoped = (living) => scopeBundle(fixture(), { tree: TREE, view: { living }, isOwner: true });
const R = (b) => b.research;

test("a full view keeps a living relative's findings, to-dos, log, status, media, stories and profile", () => {
  const b = scoped("full");
  assert.equal(b.people.I3.private, undefined);
  assert.equal(b.people.I3.events.length, 2);
  assert.match(b.people.I3.profile.text, /living relative/);
  assert.deepEqual(R(b).findings.map((f) => f.id), ["f-robin", "f-walter"]);
  assert.deepEqual(R(b).todo.map((t) => t.id), ["t-robin", "t-walter"]);
  assert.deepEqual(R(b).todo_done.map((t) => t.id), ["d-robin", "d-walter"]);
  assert.equal(R(b).research_log.length, 3);
  assert.deepEqual(Object.keys(R(b).people_status).sort(), ["I1", "I3"]);
  assert.deepEqual(Object.keys(R(b).media).sort(), ["I1", "I3"]);
  assert.deepEqual(R(b).stories.map((s) => s.slug), ["about-robin", "links-robin", "bare-link", "walter"]);
  assert.ok(JSON.stringify(b).includes(ROBIN));
});

test("a names-only view drops research about a living relative, and stories about or linking them", () => {
  const b = scoped("names-only");
  const p = b.people.I3;
  assert.equal(p.private, true);
  assert.equal(p.name, ROBIN, "the name stays");
  assert.deepEqual(p.events, []);
  assert.equal(p.profile, undefined, "no profile of a reduced living person");
  assert.deepEqual(R(b).findings.map((f) => f.id), ["f-walter"]);
  assert.deepEqual(R(b).todo.map((t) => t.id), ["t-walter"]);
  assert.deepEqual(R(b).todo_done.map((t) => t.id), ["d-walter"]);
  assert.deepEqual(R(b).research_log.map((l) => l.person || null), ["I1", null]);
  assert.deepEqual(Object.keys(R(b).people_status), ["I1"]);
  assert.deepEqual(Object.keys(R(b).media), ["I1"]);
  assert.deepEqual(R(b).stories.map((s) => s.slug), ["walter"], "about-robin, links-robin and bare-link are dropped");
  // nothing research recorded about them survives anywhere
  const json = JSON.stringify(b);
  for (const s of ["birth notice for Robin", "school records", "marriage notice", "birth notices, 1960", "robin.jpg", "living relative", "Robin's own note", "Exampleton"]) {
    assert.ok(!json.includes(s), `"${s}" leaked`);
  }
  // names are what this view shows: a name in surviving text about someone else stays
  assert.match(R(b).findings[0].finding, new RegExp(ROBIN));
  assert.match(b.people.I1.profile.text, new RegExp(ROBIN));
});

test("an anonymous view drops the same, and scrubs the living relative's real name from text that survives", () => {
  const b = scoped("anonymous");
  const p = b.people.I3;
  assert.equal(p.private, true);
  assert.equal(p.name, "Living Exampleby");
  assert.deepEqual(R(b).findings.map((f) => f.id), ["f-walter"]);
  assert.deepEqual(R(b).todo.map((t) => t.id), ["t-walter"]);
  assert.deepEqual(R(b).todo_done.map((t) => t.id), ["d-walter"]);
  assert.deepEqual(Object.keys(R(b).people_status), ["I1"]);
  assert.deepEqual(Object.keys(R(b).media), ["I1"]);
  assert.deepEqual(R(b).stories.map((s) => s.slug), ["walter"]);
  // the real name is gone from everything: a finding, a story, a profile and a log entry about someone else
  assert.ok(!JSON.stringify(b).includes(ROBIN), "the real name leaked");
  assert.equal(R(b).findings[0].finding, "Walter's obituary names his son [private] as a mourner.");
  assert.equal(R(b).stories[0].body, "[[I1|Walter Exampleby]] died in 1970, mourned by his son [private].");
  assert.match(b.people.I1.profile.text, /Their son \[private\] \(living\)/);
  assert.match(R(b).research_log.find((l) => !l.person).searched, /\(incl\. \[private\]\)/);
  // the people who died keep their names
  assert.equal(b.people.I1.name, "Walter Exampleby");
  assert.match(b.people.I1.profile.text, /married Mabel Exampleby/);
});

test("a hidden view leaves the living relative out entirely; stories about others keep, with the link scrubbed", () => {
  const b = scoped("hidden");
  assert.equal(b.people.I3, undefined);
  assert.deepEqual(R(b).findings.map((f) => f.id), ["f-walter"]);
  assert.deepEqual(R(b).todo.map((t) => t.id), ["t-walter"]);
  assert.deepEqual(Object.keys(R(b).media), ["I1"]);
  assert.deepEqual(R(b).stories.map((s) => s.slug), ["links-robin", "bare-link", "walter"], "a story shows when everyone it's about is in scope");
  assert.equal(R(b).stories[0].body, "[[I1|Walter Exampleby]] and his son [private].");
  assert.ok(!JSON.stringify(b).includes(ROBIN));
  assert.ok(!/\bI3\b/.test(JSON.stringify(b)), "no hidden id survives");
});
