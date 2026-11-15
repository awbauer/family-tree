// Close-family events on a person's timeline (web/src/familyEvents.ts, loaded with Node's type stripping): who counts
// as close family, the lifetime window, relation words by sex, half-siblings, undated events, and hidden or private
// living relatives. Invented people only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { familyEvents, lifeWindow, relationWord } from "../web/src/familyEvents.ts";

const NOW = new Date(2026, 0, 15);
const day = (y, m = 6, d = 15) => ({ date: `${d} ${m} ${y}`, sort: y * 10000 + m * 100 + d, place: "Example Town" });

/** A small invented family around "Pat Example" (P1). */
function fixture() {
  const person = (id, sex, birth, death, more = {}) => ({ id, name: `Example ${id}`, given: "Example", surname: id, sex, birth, death, events: [], famc: [], fams: [], ...more });
  const people = {
    P1: person("P1", "M", day(1900), day(1970), { famc: ["F1"], fams: ["F3"] }),
    DAD: person("DAD", "M", day(1870), day(1940), { fams: ["F1", "F2"] }),
    MUM: person("MUM", "F", day(1875), day(1980), { fams: ["F1"] }), // dies after P1: left out
    OLDER: person("OLDER", "F", day(1898), day(1950), { famc: ["F1"], fams: ["F5"] }), // born before P1: birth left out
    YOUNGER: person("YOUNGER", "M", day(1905), null, { famc: ["F1"] }),
    TWIN: person("TWIN", undefined, day(1900), null, { famc: ["F1"] }), // same day as P1: in (window is inclusive)
    HALF: person("HALF", "F", day(1925), null, { famc: ["F2"] }),
    STEPMUM: person("STEPMUM", "F", null, null, { fams: ["F2"] }),
    WIFE: person("WIFE", "F", day(1902), day(1960), { fams: ["F3"] }),
    SON: person("SON", "M", day(1930), day(2001), { famc: ["F3"], fams: ["F4"] }),
    KID: person("KID", "X", { date: "c. 1932", sort: 19320615, place: "" }, null, { famc: ["F3"] }),
    UNDATED: person("UNDATED", "F", { date: "", sort: null, place: "" }, null, { famc: ["F3"] }),
    INLAW: person("INLAW", "F", day(1931), null, { fams: ["F4"] }),
    BIL: person("BIL", "M", day(1897), null, { fams: ["F5"] }),
  };
  const families = {
    F1: { id: "F1", husband: "DAD", wife: "MUM", children: ["OLDER", "P1", "TWIN", "YOUNGER"], events: [{ type: "Marriage", dateDisplay: "1897", sort: 18970615 }] },
    F2: { id: "F2", husband: "DAD", wife: "STEPMUM", children: ["HALF"], events: [{ type: "Marriage", dateDisplay: "after 1923", sort: 19230615 }] },
    F3: { id: "F3", husband: "P1", wife: "WIFE", children: ["SON", "KID", "UNDATED"], events: [{ type: "Marriage", dateDisplay: "1928", sort: 19280615 }] },
    F4: { id: "F4", husband: "SON", wife: "INLAW", children: [], events: [{ type: "Marriage", dateDisplay: "1955", sort: 19550615 }] },
    F5: { id: "F5", husband: "BIL", wife: "OLDER", children: [], events: [{ type: "Marriage", dateDisplay: "abt 1920", sort: null }] }, // undated
  };
  return { people, families, research: {}, sources: {}, media: {}, home: "P1", generated: "" };
}
const labels = (D, id = "P1") => familyEvents(D, id, NOW).map((e) => `${e.label}${e.who ? ` ${e.who}` : ""}${e.partner ? ` to ${e.partner}` : ""}`);

test("relation words follow the relative's recorded sex", () => {
  const cases = { parent: ["Father", "Mother", "Parent"], sibling: ["Brother", "Sister", "Sibling"], "half-sibling": ["Half-brother", "Half-sister", "Half-sibling"],
    spouse: ["Husband", "Wife", "Spouse"], child: ["Son", "Daughter", "Child"] };
  for (const [role, [m, f, u]] of Object.entries(cases)) {
    assert.equal(relationWord(role, "M"), m);
    assert.equal(relationWord(role, "F"), f);
    assert.equal(relationWord(role, "U"), u);
    assert.equal(relationWord(role, undefined), u);
  }
});

test("only events within the person's lifetime, in date order", () => {
  const D = fixture();
  assert.deepEqual(labels(D), [
    "Sibling born TWIN",
    "Wife born WIFE",
    "Brother born YOUNGER",
    "Father married DAD to STEPMUM",
    "Half-sister born HALF",
    "Son born SON",
    "Child born KID",
    "Father died DAD",
    "Sister died OLDER",
    "Son married SON to INLAW",
    "Wife died WIFE",
  ]);
  const all = labels(D);
  assert.ok(!all.includes("Sister born OLDER"), "a sibling born before the person is left out");
  assert.ok(!all.includes("Mother died MUM"), "a parent's death after the person's own is left out");
  assert.ok(!all.includes("Son died SON"), "a child's death after the person's own is left out");
  assert.ok(!all.includes("Parents married"), "the parents' marriage before the person's birth is left out");
  assert.ok(!all.some((x) => x.startsWith("Father born") || x.startsWith("Mother born")), "parents' births are always before");
  // a wife born before the person: her birth is left out
  D.people.WIFE.birth = day(1899);
  assert.ok(!labels(D).includes("Wife born WIFE"));
  // a husband, from the wife's side
  assert.ok(labels(D, "WIFE").includes("Husband born P1"));
  assert.ok(!labels(D, "WIFE").includes("Husband died P1"), "he died after her");
});

test("the window: birth to death, today if living, last dated event otherwise", () => {
  const D = fixture();
  assert.deepEqual(lifeWindow(D, "P1", NOW), [19000615, 19700615]);
  D.people.P1.death = null; D.people.P1.living = true;
  assert.deepEqual(lifeWindow(D, "P1", NOW), [19000615, 20260115]);
  assert.ok(labels(D).includes("Mother died MUM") && labels(D).includes("Son died SON"), "a living person sees events up to today");
  D.people.P1.living = false; D.people.P1.events = [{ type: "Residence", sort: 19350615 }, { type: "Note", sort: null }];
  assert.deepEqual(lifeWindow(D, "P1", NOW), [19000615, 19350615], "dead with no death date: up to the last dated event");
  D.people.P1.birth = null;
  assert.equal(lifeWindow(D, "P1", NOW), null);
  assert.deepEqual(familyEvents(D, "P1", NOW), [], "no birth date: nothing is guessed");
});

test("undated events are left out; date qualifiers are kept", () => {
  const D = fixture();
  const ev = familyEvents(D, "P1", NOW);
  assert.ok(!ev.some((e) => e.who === "UNDATED"), "a birth with no usable date is left out");
  assert.ok(!ev.some((e) => e.who === "OLDER" && /married/.test(e.label)), "an undated marriage is left out");
  assert.equal(ev.find((e) => e.who === "KID").dateDisplay, "c. 1932");
  assert.equal(ev.find((e) => e.who === "DAD" && /married/.test(e.label)).dateDisplay, "after 1923");
  assert.equal(ev.find((e) => e.who === "SON" && /born/.test(e.label)).place, "Example Town");
});

test("half-siblings come from a parent's other families; full siblings stay full", () => {
  const D = fixture();
  const ev = familyEvents(D, "P1", NOW);
  assert.equal(ev.find((e) => e.who === "HALF").label, "Half-sister born");
  // a child of both the person's parents' family and another family of one parent is a full sibling
  D.families.F2.children.push("YOUNGER"); D.people.YOUNGER.famc.push("F2");
  assert.equal(familyEvents(D, "P1", NOW).find((e) => e.who === "YOUNGER").label, "Brother born");
});

test("parents marrying during the person's life is one row, and the person's own marriage isn't repeated", () => {
  const D = fixture();
  D.families.F1.events[0].sort = 19010615; D.families.F1.events[0].dateDisplay = "1901";
  const l = labels(D);
  assert.equal(l.filter((x) => x === "Parents married").length, 1);
  assert.ok(!l.some((x) => /married P1|to P1/.test(x)), "the person's own marriage stays an own event");
});

test("a view that hides living people: hidden relatives produce no rows", () => {
  // worker/scope.js with living: "hidden" drops the person and every link to them
  const D = fixture();
  delete D.people.HALF; D.families.F2.children = [];
  delete D.people.INLAW; D.families.F4.wife = null;
  const l = labels(D);
  assert.ok(!l.some((x) => /HALF|INLAW/.test(x)));
  assert.ok(l.includes("Son married SON"), "the visible relative's marriage stays, with no partner named");
  // a stale id that isn't in the tree is ignored
  D.families.F1.children.push("GONE");
  assert.doesNotThrow(() => familyEvents(D, "P1", NOW));
});

test("names-only and anonymous views: private living relatives produce no rows, nor do their marriages", () => {
  const D = fixture();
  // what scope.js leaves of a living person in those views (dates kept here to prove they're ignored anyway)
  Object.assign(D.people.YOUNGER, { private: true });
  Object.assign(D.people.INLAW, { private: true, birth: null, death: null, events: [] });
  const l = labels(D);
  assert.ok(!l.some((x) => /YOUNGER|INLAW/.test(x)), l.join(", "));
  assert.ok(!l.some((x) => /Son married/.test(x)), "a marriage to a private person is left out");
});
