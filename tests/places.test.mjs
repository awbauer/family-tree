// Places on the maps: place.save / place.delete (config place_map over the places.json gazetteer), exact place texts
// that win over a town's pattern, photos and documents placed with `place` / `places`, and list_places.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEnv, client, migrate } from "./helpers/fake-env.mjs";
import { placeTree, placeText } from "../worker/derive.js";
import { places as listPlaces, place as getPlace } from "../worker/mcp-views.js";
import { exportDoc } from "../worker/gedcomx.js";
import { exportGedcom } from "../worker/gedcom_export.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "owner@example.test", EDITOR = "editor@example.test", MEMBER = "member@example.test", NARROW = "narrow@example.test";
let env, call, any, outside, branchOne;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ft-pl-"));
  execFileSync("python3", ["tools/build.py", "--data", "example", "--out", dir, "--raw-out", join(dir, "raw.json")], { cwd: ROOT });
  const research = JSON.parse(readFileSync(join(ROOT, "example/research.json"), "utf8"));
  branchOne = research.branches[0].key;
  research.trees = [{ id: "all", name: "Everyone", definition: { branches: ["*"] } }, { id: "one", name: "One branch", definition: { branches: [branchOne] } }];
  writeFileSync(join(dir, "research.json"), JSON.stringify(research));
  execFileSync("python3", ["tools/seed_app.py", "--raw", join(dir, "raw.json"), "--bundle", join(dir, "family.json"), "--research", join(dir, "research.json"), "--out", join(dir, "seed.sql"), "--owner", OWNER, "--cutover"], { cwd: ROOT });
  env = makeEnv();
  migrate(env.DB, ROOT);
  env.DB.execFile(join(dir, "seed.sql"));
  call = client((await import("../worker/index.js")).default, env);
  await call("PUT", "/api/admin/grants", { body: { principal: EDITOR, tree_id: "all", role: "editor" } });
  await call("PUT", "/api/admin/grants", { body: { principal: MEMBER, tree_id: "all", role: "member" } });
  const ex = JSON.parse(readFileSync(join(dir, "family.json"), "utf8"));
  any = Object.values(ex.people).find((p) => !p.living).id;
  await call("PUT", "/api/admin/grants", { body: { principal: NARROW, tree_id: "one", role: "member" } });
  const narrow = (await call("GET", "/api/tree?tree=one", { as: NARROW })).data;
  outside = Object.values(ex.people).find((p) => !p.living && !narrow.people[p.id]).id;
});

/** The stored place records, by key. */
const stored = async () => Object.fromEntries((await env.DB.prepare("SELECT id, data FROM place_records").all()).results.map((r) => [r.id, JSON.parse(r.data)]));
const tree = async (as = OWNER) => (await call("GET", "/api/tree?tree=all", { as })).data;
const edit = (ops, as = EDITOR) => call("POST", "/api/edit", { as, body: { tree: "all", reason: "places", ops } });
const STREET = "14 Fenwick Row, Leeds, England";

test("placeTree: full names up the parent chain, points borrowed from the enclosing place, loops cut", () => {
  const out = placeTree([
    { key: "land", name: "Westland", type: "country", lat: 50, lng: 5 },
    { key: "town", name: "Ashby", type: "city", parent: "land", lat: 51, lng: 6, names: [{ name: "Old Ashby", to: 1900 }] },
    { key: "street", name: "Mill Street", type: "street", parent: "town" },
    { key: "house", name: "No. 4", type: "building", parent: "street", lat: 51.001, lng: 6.002 },
    { key: "nowhere", name: "No point anywhere" },
    { key: "a", name: "A", parent: "b" }, { key: "b", name: "B", parent: "a", lat: 1, lng: 1 },
  ]);
  assert.equal(out.house.name, "No. 4, Mill Street, Ashby, Westland");
  assert.equal(out.house.short, "No. 4");
  assert.equal(out.house.parent, "street");
  assert.equal(out.house.approx, undefined);
  assert.deepEqual([out.street.lat, out.street.lng, out.street.approx], [51, 6, true], "a street without a point takes the town's");
  assert.deepEqual(out.town.names, [{ name: "Old Ashby", to: 1900 }]);
  assert.equal(out.nowhere, undefined, "a place with no point of its own or above it can't go on the map");
  assert.equal(out.b.name, "B, A");
  assert.equal(placeText("  Fenwick  Row, Leeds , "), "fenwick row, leeds");
});

test("a place saved with its exact text wins over a town's pattern, and can be reverted", async () => {
  // the example gazetteer maps anything with "leeds" to Leeds
  const add = await edit([{ op: "event.add", entity: "person", id: any, event: { type: "Residence", date: "1901", place: STREET } }]);
  assert.equal(add.status, 200, JSON.stringify(add.data));
  let d = await tree();
  assert.equal(d.people[any].events.find((e) => e.place === STREET).placeKey, "leeds");

  const r = await edit([{ op: "place.save", key: "fenwick-row-14", name: "14 Fenwick Row, Leeds", lat: 53.79, lng: -1.54, texts: [STREET] }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  d = await tree();
  assert.equal(d.people[any].events.find((e) => e.place === STREET).placeKey, "fenwick-row-14");
  assert.deepEqual(d.places["fenwick-row-14"], { name: "14 Fenwick Row, Leeds", short: "14 Fenwick Row, Leeds", lat: 53.79, lng: -1.54, texts: [STREET] });

  const h = await call("GET", "/api/history?tree=all", { as: EDITOR });
  assert.ok(h.data.history.some((b) => b.batch === r.data.batch && b.entities.some((x) => x.type === "place" && x.id === "fenwick-row-14")));
  const rv = await call("POST", `/api/changes/${r.data.batch}/revert`, { as: EDITOR });
  assert.equal(rv.status, 200, JSON.stringify(rv.data));
  d = await tree();
  assert.equal(d.places["fenwick-row-14"], undefined);
  assert.equal(d.people[any].events.find((e) => e.place === STREET).placeKey, "leeds");
});

test("a place from places.json can be moved, renamed, given texts and taken off the map", async () => {
  const before = (await tree()).places.leeds;
  assert.ok(before);
  let r = await edit([{ op: "place.save", key: "leeds", lat: 53.8, lng: before.lng, name: "Leeds, Yorkshire", add_texts: ["Headingley"] }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let d = await tree();
  assert.equal(d.places.leeds.name, "Leeds, Yorkshire");
  assert.equal(d.places.leeds.lat, 53.8);
  assert.equal((await edit([{ op: "place.save", key: "leeds", lat: 1 }])).status, 200, "lat alone keeps the stored lng");
  assert.equal((await edit([{ op: "place.save", key: "leeds", lng: null }])).status, 422, "a point needs both");
  r = await edit([{ op: "place.delete", key: "leeds" }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  d = await tree();
  assert.equal(d.places.leeds, undefined);
  assert.ok(Object.values(d.people).flatMap((p) => p.events).every((e) => e.placeKey !== "leeds"));
  assert.equal((await call("POST", `/api/changes/${r.data.batch}/revert`, { as: EDITOR })).status, 200, "undoing the delete brings it back, patterns and all");
  d = await tree();
  assert.ok(d.places.leeds);
  assert.ok(Object.values(d.people).flatMap((p) => p.events).some((e) => e.placeKey === "leeds"));
  await edit([{ op: "place.save", key: "leeds", name: before.name, lat: before.lat, lng: before.lng, remove_texts: ["Headingley"] }]);
});

test("a text saved on one place moves off the place that had it", async () => {
  let r = await edit([{ op: "place.save", key: "mill-a", name: "Mill A", lat: 1, lng: 1, texts: ["The mill"] }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await edit([{ op: "place.save", key: "mill-b", name: "Mill B", lat: 2, lng: 2, texts: ["the mill"] }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const map = await stored();
  assert.equal(map["mill-a"].texts, undefined);
  assert.deepEqual(map["mill-b"].texts, ["the mill"]);
});

test("bad place ops are refused", async () => {
  for (const op of [
    { op: "place.save", key: "Not A Key", name: "x", lat: 1, lng: 1 },
    { op: "place.save", key: "new-place", name: "No coordinates" },
    { op: "place.save", key: "new-place", name: "Bad parent", parent: "no-such-place" },
    { op: "place.save", key: "new-place", name: "Bad type", lat: 1, lng: 1, type: "planet" },
    { op: "place.save", key: "new-place", name: "Bad year", lat: 1, lng: 1, names: [{ name: "Old", to: "soon" }] },
    { op: "place.save", key: "leeds", parent: "leeds" },
    { op: "place.merge", keep: "leeds", drop: "leeds" },
    { op: "place.save", key: "far", name: "Far", lat: 91, lng: 0 },
    { op: "place.save", key: "far", name: "Far", lat: 0, lng: "east" },
    { op: "place.delete", key: "never-was" },
  ]) assert.equal((await edit([op])).status, 422, JSON.stringify(op));
});

test("a member's place is a suggestion until an editor approves it", async () => {
  const r = await call("POST", "/api/proposals", { as: MEMBER, body: { tree: "all", kind: "edit", rationale: "found it on the map", payload: { reason: "place", ops: [{ op: "place.save", key: "suggested", name: "Suggested", lat: 10, lng: 10 }] } } });
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.data));
  assert.equal((await tree()).places.suggested, undefined);
  assert.equal((await edit([{ op: "place.save", key: "x", name: "x", lat: 1, lng: 1 }], MEMBER)).status, 403);
});

test("photos and documents are placed by place and places, and list_places counts them", async () => {
  const up = await (await import("../worker/index.js")).default.fetch(new Request("https://x.test/api/media/upload?tree=all&name=street.jpg", {
    method: "POST", headers: { "X-Dev-Principal": EDITOR, "Content-Type": "image/jpeg" }, body: new Uint8Array([255, 216, 255, 0]) }), env, {});
  const { key } = await up.json();
  await edit([{ op: "place.save", key: "fenwick-row-14", name: "14 Fenwick Row, Leeds", lat: 53.79, lng: -1.54, texts: [STREET] }]);
  const r = await edit([{ op: "media.attach", person: any, file: key, caption: "The house", place: STREET, places: ["Dover", "", "Dover", "Nowhere in particular"] }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = await tree();
  const m = d.research.media[any].find((x) => x.file === key);
  assert.deepEqual(m.places, ["Dover", "Nowhere in particular"]);
  assert.deepEqual(m.placeKeys, ["fenwick-row-14", "dover"]);
  assert.equal((await edit([{ op: "media.update", person: any, file: key, set: { places: Array.from({ length: 31 }, (_, i) => `P${i}`) } }])).status, 422);

  const all = listPlaces(d, {});
  const row = all.places.find((p) => p.key === "fenwick-row-14");
  assert.equal(row.on_map, true);
  assert.equal(row.documents, 1);
  const unmapped = listPlaces(d, { unmapped: true });
  assert.ok(unmapped.places.every((p) => !p.on_map));
  assert.equal(unmapped.unmapped_total, unmapped.places.length);
});

test("a viewer gets only the places, and place texts, that the records they can see use", async () => {
  const ADDRESS = "7 Quarry Lane, Leeds, England";
  let r = await edit([
    { op: "event.add", entity: "person", id: outside, event: { type: "Residence", date: "1930", place: ADDRESS } },
    { op: "place.save", key: "quarry-lane-7", name: "7 Quarry Lane, Leeds", lat: 53.81, lng: -1.56, texts: [ADDRESS] },
    { op: "place.save", key: "unused-place", name: "Nothing here", lat: 1, lng: 1 },
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const full = await tree();
  assert.deepEqual(full.places["quarry-lane-7"].texts, [ADDRESS]);
  assert.ok(full.places["unused-place"], "a view that hides no one gets every place");

  const narrow = (await call("GET", "/api/tree?tree=one", { as: NARROW })).data;
  assert.equal(narrow.people[outside], undefined);
  assert.equal(narrow.places["quarry-lane-7"], undefined, "the address of someone outside the view stays hidden");
  assert.ok(!JSON.stringify(narrow).includes("Quarry Lane"));
  assert.equal(narrow.places["unused-place"], undefined, "a narrower view gets only the places its records use");
  assert.ok(Object.keys(narrow.places).length > 0, "places the view's own records use are still there");
  for (const [k, pl] of Object.entries(narrow.places)) {
    assert.ok(Object.values(narrow.people).some((p) => (p.events || []).some((e) => e.placeKey === k))
      || Object.values(narrow.families).some((f) => (f.events || []).some((e) => e.placeKey === k))
      || Object.values(narrow.research.media || {}).some((l) => l.some((m) => (m.placeKeys || []).includes(k))), k);
    for (const t of pl.texts || []) assert.ok(JSON.stringify(narrow.people).includes(JSON.stringify(t).slice(1, -1)) || JSON.stringify(narrow.research.media || {}).includes(JSON.stringify(t).slice(1, -1)), t);
  }
});

test("place texts move between places when they match events the same way (case, spacing, commas)", async () => {
  let r = await edit([{ op: "place.save", key: "mill-c", name: "Mill C", lat: 3, lng: 3, texts: ["Old Mill,  Leeds,"] }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await edit([{ op: "place.save", key: "mill-d", name: "Mill D", lat: 4, lng: 4, texts: ["old mill, leeds", "OLD MILL ,LEEDS"] }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const map = await stored();
  assert.equal(map["mill-c"].texts, undefined, "the text left the place that had it");
  assert.deepEqual(map["mill-d"].texts.length, 1, "one text, however it was spaced");
});

test("a hierarchy: a building in a street in a town in a country, rolled up and shown in order", async () => {
  let r = await edit([
    { op: "place.save", key: "england", name: "England", type: "country", lat: 52.5, lng: -1.5 },
    { op: "place.save", key: "leeds", name: "Leeds", type: "city", parent: "england", names: [{ name: "Loidis", to: 1200 }] },
    { op: "place.save", key: "fenwick-row", name: "Fenwick Row", type: "street", parent: "leeds" },
    { op: "place.save", key: "fenwick-row-14", name: "No. 14", type: "building", parent: "fenwick-row" },
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = await tree();
  assert.equal(d.places["fenwick-row-14"].name, "No. 14, Fenwick Row, Leeds, England");
  assert.equal(d.places["fenwick-row-14"].lat, 53.79, "a building keeps its own point");
  assert.equal(d.places["fenwick-row"].approx, true, "a street without a point is shown at the town's");
  assert.equal(d.places.leeds.name, "Leeds, England");
  assert.equal(d.places.england.type, "country");
  // a loop is refused; so is deleting a place with places inside it
  assert.equal((await edit([{ op: "place.save", key: "england", parent: "fenwick-row-14" }])).status, 422);
  assert.equal((await edit([{ op: "place.delete", key: "fenwick-row" }])).status, 422);
  // MCP: the record with what encloses it, what's inside, and what happened there and inside
  const g = getPlace(d, { key: "leeds" });
  assert.deepEqual(g.within.map((x) => x.key), ["england"]);
  assert.deepEqual(g.places_inside.map((x) => x.key), ["fenwick-row"]);
  assert.ok(g.events.some((e) => e.at === "No. 14, Fenwick Row, Leeds, England"), "events inside it are rolled up, marked with where");
  assert.ok(getPlace(d, {}).places.some((x) => x.key === "england" && x.places_inside >= 3));
});

test("a fact can point at a place record whatever its text says; merging and deleting respect that", async () => {
  let r = await edit([
    { op: "place.save", key: "ivy-cottage", name: "Ivy Cottage", type: "building", parent: "leeds", lat: 53.83, lng: -1.6 },
    { op: "event.add", entity: "person", id: any, event: { type: "Residence", date: "1912", place: "the cottage", place_ref: "ivy-cottage" } },
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let p = (await tree()).people[any];
  let ev = p.events.find((e) => e.place === "the cottage");
  assert.equal(ev.place_ref, "ivy-cottage");
  assert.equal(ev.placeKey, "ivy-cottage");
  assert.equal((await edit([{ op: "event.add", entity: "person", id: any, event: { type: "Residence", place_ref: "no-such-place" } }])).status, 422);
  assert.equal((await edit([{ op: "place.delete", key: "ivy-cottage" }])).status, 422, "facts point at it");

  // exports: GEDCOM X places with their enclosing places, facts with descriptionRef; GEDCOM 7 with the point
  const d = await tree();
  const gx = exportDoc(d);
  const ids = new Set(gx.places.map((x) => x.id));
  for (const k of ["ivy-cottage", "leeds", "england"]) assert.ok(ids.has(k), k);
  assert.equal(gx.places.find((x) => x.id === "ivy-cottage").jurisdiction.resource, "#leeds");
  assert.ok(JSON.stringify(gx.persons).includes('"descriptionRef":"#ivy-cottage"'));
  assert.match(exportGedcom(d, {}), /2 PLAC the cottage\r?\n3 MAP\r?\n4 LATI N53\.83\r?\n4 LONG W1\.6/);

  // a merge moves the fact's link, the places inside and the texts; the dropped name becomes another name
  r = await edit([
    { op: "place.save", key: "ivy-cottage-2", name: "Ivy Cott.", parent: "leeds", texts: ["Ivy Cott., Leeds"] },
    { op: "place.save", key: "ivy-cottage-garden", name: "Garden", parent: "ivy-cottage" },
    { op: "place.merge", keep: "ivy-cottage-2", drop: "ivy-cottage" },
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const m = await tree();
  ev = m.people[any].events.find((e) => e.place === "the cottage");
  assert.equal(ev.place_ref, "ivy-cottage-2");
  assert.equal(m.places["ivy-cottage"], undefined);
  assert.equal((await stored())["ivy-cottage-garden"].parent, "ivy-cottage-2");
  assert.equal(m.places["ivy-cottage-2"].lat, 53.83, "the kept place takes the dropped one's point when it had none");
  assert.ok(m.places["ivy-cottage-2"].names.some((n) => n.name === "Ivy Cottage"));
  assert.equal((await call("POST", `/api/changes/${r.data.batch}/revert`, { as: EDITOR })).status, 200, "a merge can be undone");
  assert.equal((await tree()).people[any].events.find((e) => e.place === "the cottage").place_ref, "ivy-cottage");

  // changing the text without a place_ref unlinks it
  r = await edit([{ op: "event.update", entity: "person", id: any, fid: ev.fid, set: { place: "Somewhere else entirely" } }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  p = (await tree()).people[any];
  assert.equal(p.events.find((e) => e.fid === ev.fid).place_ref, undefined);
});

test("a viewer sees the places enclosing theirs, by name and point only", async () => {
  await edit([{ op: "place.save", key: "england", note: "A note about the country" }]);
  const d = await tree();
  const narrow = (await call("GET", "/api/tree?tree=one", { as: NARROW })).data;
  for (const [k, pl] of Object.entries(narrow.places)) if (pl.parent) assert.ok(narrow.places[pl.parent], `${k}'s parent is there`);
  if (narrow.places.england && !Object.values(narrow.people).some((p) => (p.events || []).some((e) => e.placeKey === "england"))) {
    assert.equal(narrow.places.england.note, undefined, "only the name and point of a place that just encloses others");
    assert.equal(narrow.places.england.texts, undefined);
  }
  assert.equal(d.places.england.note, "A note about the country");
});

test("migration 0015 turns places.json and the places saved in the app into place records", async () => {
  const db = makeEnv().DB;
  const files = readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files.filter((f) => f < "0015")) db.execFile(join(ROOT, "migrations", f));
  const gaz = { _comment: "x", places: [{ key: "york", name: "York, England", lat: 53.96, lng: -1.08, match: ["^york"] }, { key: "leeds", name: "Leeds, England", lat: 53.8, lng: -1.55, match: ["leeds"] }, { key: "dover", name: "Dover", lat: 51.1, lng: 1.3, match: ["dover"] }] };
  const saved = { leeds: { name: "Leeds", lat: 53.81, texts: ["Leeds, Yorks."] }, dover: { removed: true }, "mill-row": { name: "Mill Row, Leeds", lat: 53.79, lng: -1.54, texts: ["Mill Row, Leeds"] }, broken: { name: "No point" } };
  await db.prepare("INSERT INTO config (key, value) VALUES ('places', ?), ('place_map', ?)").bind(JSON.stringify(gaz), JSON.stringify(saved)).run();
  db.execFile(join(ROOT, "migrations", files.find((f) => f.startsWith("0015"))));
  const rows = Object.fromEntries((await db.prepare("SELECT id, data FROM place_records").all()).results.map((r) => [r.id, JSON.parse(r.data)]));
  assert.deepEqual(Object.keys(rows).sort(), ["leeds", "mill-row", "york"]);
  assert.deepEqual(rows.york, { name: "York, England", lat: 53.96, lng: -1.08, match: ["^york"], order: 0 });
  assert.deepEqual(rows.leeds, { name: "Leeds", lat: 53.81, lng: -1.55, match: ["leeds"], order: 1, texts: ["Leeds, Yorks."] });
  assert.deepEqual(rows["mill-row"], { name: "Mill Row, Leeds", lat: 53.79, lng: -1.54, texts: ["Mill Row, Leeds"] });
});


test("a view without notes gets no place notes, whether or not it hides anyone", async () => {
  await edit([{ op: "place.save", key: "england", note: "Household details" }]);
  const QUIET = "quiet@example.test";
  await call("PUT", "/api/admin/views/quiet", { body: { name: "No notes", filter: { living: "full", notes: false } } });
  await call("PUT", "/api/admin/grants", { body: { principal: QUIET, tree_id: "all", role: "member", view_id: "quiet" } });
  const d = (await call("GET", "/api/tree?tree=all", { as: QUIET })).data;
  assert.ok(Object.keys(d.places).length);
  assert.ok(Object.values(d.places).every((pl) => pl.note === undefined));
  assert.equal((await tree()).places.england.note, "Household details");
});

test("facts matched by a place's full name keep it when the place is renamed, moved or merged", async () => {
  let r = await edit([
    { op: "place.save", key: "old-cottage", name: "Old Cottage", lat: 54, lng: -1 },
    { op: "place.save", key: "old-cottage-gate", name: "Gate", parent: "old-cottage" },
    { op: "event.add", entity: "person", id: any, event: { type: "Residence", date: "1920", place: "Old Cottage" } },
    { op: "event.add", entity: "person", id: any, event: { type: "Residence", date: "1921", place: "Gate, Old Cottage" } },
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const at = async (place) => (await tree()).people[any].events.find((e) => e.place === place).placeKey;
  assert.equal(await at("Old Cottage"), "old-cottage");
  assert.equal(await at("Gate, Old Cottage"), "old-cottage-gate");
  r = await edit([{ op: "place.save", key: "old-cottage", name: "Rose Cottage" }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(await at("Old Cottage"), "old-cottage", "renamed: the old full name is kept as a text");
  assert.equal(await at("Gate, Old Cottage"), "old-cottage-gate", "and so is the old full name of a place inside it");
  r = await edit([
    { op: "place.save", key: "new-cottage", name: "New Cottage", lat: 54.1, lng: -1.1 },
    { op: "place.merge", keep: "new-cottage", drop: "old-cottage" },
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(await at("Old Cottage"), "new-cottage", "merged: facts follow to the kept place");
  assert.equal(await at("Gate, Old Cottage"), "old-cottage-gate");
  assert.equal((await tree()).places["old-cottage-gate"].name, "Gate, New Cottage");
});
