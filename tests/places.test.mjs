// Places on the maps: place.save / place.delete (config place_map over the places.json gazetteer), exact place texts
// that win over a town's pattern, photos and documents placed with `place` / `places`, and list_places.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEnv, client, migrate } from "./helpers/fake-env.mjs";
import { withPlaceEdits, placeText } from "../worker/derive.js";
import { places as listPlaces } from "../worker/mcp-views.js";

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

const tree = async (as = OWNER) => (await call("GET", "/api/tree?tree=all", { as })).data;
const edit = (ops, as = EDITOR) => call("POST", "/api/edit", { as, body: { tree: "all", reason: "places", ops } });
const STREET = "14 Fenwick Row, Leeds, England";

test("withPlaceEdits: changes, removes and adds places over the gazetteer", () => {
  const gaz = { places: [{ key: "a", name: "A", lat: 1, lng: 2, match: ["^a"] }, { key: "b", name: "B", lat: 3, lng: 4, match: ["b"] }] };
  const out = withPlaceEdits(gaz, { a: { lat: 9, texts: ["A town"] }, b: { removed: true }, c: { name: "C", lat: 5, lng: 6, texts: ["C"] }, d: { name: "no coordinates" } }).places;
  assert.deepEqual(out.map((p) => p.key), ["a", "c"]);
  assert.equal(out[0].lat, 9);
  assert.equal(out[0].lng, 2);
  assert.deepEqual(out[0].match, ["^a"]);
  assert.equal(out[1].added, true);
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
  assert.deepEqual(d.places["fenwick-row-14"], { name: "14 Fenwick Row, Leeds", lat: 53.79, lng: -1.54, texts: [STREET], added: true });

  const h = await call("GET", "/api/history?tree=all", { as: EDITOR });
  assert.ok(h.data.history.some((b) => b.batch === r.data.batch && b.entities.some((x) => x.type === "config" && x.id === "place_map")));
  const rv = await call("POST", `/api/changes/${r.data.batch}/revert`, { as: EDITOR });
  assert.equal(rv.status, 200, JSON.stringify(rv.data));
  d = await tree();
  assert.equal(d.places["fenwick-row-14"], undefined);
  assert.equal(d.people[any].events.find((e) => e.place === STREET).placeKey, "leeds");
});

test("a place from places.json can be moved, renamed, given texts and taken off the map", async () => {
  const before = (await tree()).places.leeds;
  assert.ok(before);
  let r = await edit([{ op: "place.save", key: "leeds", lat: 53.8, name: "Leeds, Yorkshire", add_texts: ["Headingley"] }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let d = await tree();
  assert.equal(d.places.leeds.name, "Leeds, Yorkshire");
  assert.equal(d.places.leeds.lat, 53.8);
  assert.equal(d.places.leeds.lng, before.lng);
  r = await edit([{ op: "place.delete", key: "leeds" }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  d = await tree();
  assert.equal(d.places.leeds, undefined);
  assert.ok(Object.values(d.people).flatMap((p) => p.events).every((e) => e.placeKey !== "leeds"));
  r = await edit([{ op: "place.save", key: "leeds", lat: before.lat, name: before.name }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await tree()).places.leeds.lng, before.lng);
});

test("a text saved on one place moves off the place that had it", async () => {
  let r = await edit([{ op: "place.save", key: "mill-a", name: "Mill A", lat: 1, lng: 1, texts: ["The mill"] }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await edit([{ op: "place.save", key: "mill-b", name: "Mill B", lat: 2, lng: 2, texts: ["the mill"] }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const map = JSON.parse((await env.DB.prepare("SELECT value FROM config WHERE key = 'place_map'").first()).value);
  assert.equal(map["mill-a"].texts, undefined);
  assert.deepEqual(map["mill-b"].texts, ["the mill"]);
});

test("bad place ops are refused", async () => {
  for (const op of [
    { op: "place.save", key: "Not A Key", name: "x", lat: 1, lng: 1 },
    { op: "place.save", key: "new-place", name: "No coordinates" },
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
  assert.equal(full.places["unused-place"], undefined, "a place nothing uses isn't sent");

  const narrow = (await call("GET", "/api/tree?tree=one", { as: NARROW })).data;
  assert.equal(narrow.people[outside], undefined);
  assert.equal(narrow.places["quarry-lane-7"], undefined, "the address of someone outside the view stays hidden");
  assert.ok(!JSON.stringify(narrow).includes("Quarry Lane"));
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
  const map = JSON.parse((await env.DB.prepare("SELECT value FROM config WHERE key = 'place_map'").first()).value);
  assert.equal(map["mill-c"].texts, undefined, "the text left the place that had it");
  assert.deepEqual(map["mill-d"].texts.length, 1, "one text, however it was spaced");
});

