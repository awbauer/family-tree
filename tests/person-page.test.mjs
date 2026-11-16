// Person page features: structured citations (evidence analysis + QUAY), fact reviews with evidence, photos (main
// photo, details), edit previews for diffs, findings resolved by edits or dismissed with a reason, and the person's
// history including photo and finding changes. Fictional example family only.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEnv, client, migrate } from "./helpers/fake-env.mjs";
import { applyOps, OpError } from "../worker/ops.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "owner@example.test", EDITOR = "editor@example.test", MEMBER = "member@example.test";
let env, call, ex, pid, ev;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ft-pp-"));
  execFileSync("python3", ["tools/build.py", "--data", "example", "--out", dir, "--raw-out", join(dir, "raw.json")], { cwd: ROOT });
  const research = JSON.parse(readFileSync(join(ROOT, "example/research.json"), "utf8"));
  research.trees = [{ id: "all", name: "Everyone", definition: { branches: ["*"] } }];
  writeFileSync(join(dir, "research.json"), JSON.stringify(research));
  execFileSync("python3", ["tools/seed_app.py", "--raw", join(dir, "raw.json"), "--bundle", join(dir, "family.json"), "--research", join(dir, "research.json"), "--out", join(dir, "seed.sql"), "--owner", OWNER, "--cutover"], { cwd: ROOT });
  env = makeEnv();
  migrate(env.DB, ROOT);
  env.DB.execFile(join(dir, "seed.sql"));
  call = client((await import("../worker/index.js")).default, env);
  ex = JSON.parse(readFileSync(join(dir, "family.json"), "utf8"));
  await call("PUT", "/api/admin/grants", { body: { principal: EDITOR, tree_id: "all", role: "editor" } });
  await call("PUT", "/api/admin/grants", { body: { principal: MEMBER, tree_id: "all", role: "member" } });
  const p = Object.values(ex.people).find((x) => !x.living && x.events.length >= 2);
  pid = p.id;
  ev = (await person()).events.find((e) => e.fid);
});

const person = async (as = EDITOR) => (await call("GET", "/api/tree?tree=all", { as })).data.people[pid];
const tree = async (as = EDITOR) => (await call("GET", "/api/tree?tree=all", { as })).data;
const edit = (body, as = EDITOR) => call("POST", "/api/edit", { as, body: { tree: "all", reason: "test", ...body } });

test("citations carry evidence analysis and GEDCOM quality, validated", () => {
  const state = { people: { I1: { id: "I1", names: [{ given: "A", surname: "B", fid: "n1" }], events: [{ type: "Birth", fid: "e1" }], famc: [], fams: [] } }, families: {}, sources: {} };
  const ok = applyOps(state, [{ op: "citation.add", entity: "person", id: "I1", fid: "e1", citation: { title: "Parish register", url: "https://example.org/r/1", page: "f. 12, entry 4", source_type: "original", information: "primary", evidence: "direct", quality: "3", accessed: "2026-11-15" } }]);
  assert.deepEqual(ok.state.people.I1.events[0].citations[0], { title: "Parish register", page: "f. 12, entry 4", url: "https://example.org/r/1", accessed: "2026-11-15", source_type: "original", information: "primary", evidence: "direct", quality: "3" });
  assert.throws(() => applyOps(state, [{ op: "citation.add", entity: "person", id: "I1", fid: "e1", citation: { title: "x", quality: "5" } }]), OpError);
  assert.throws(() => applyOps(state, [{ op: "citation.add", entity: "person", id: "I1", fid: "e1", citation: { title: "x", source_type: "gossip" } }]), OpError);
  assert.throws(() => applyOps(state, [{ op: "citation.add", entity: "person", id: "I1", fid: "e1", citation: { url: "javascript:alert(1)" } }]), OpError);
  // names are facts too
  const n = applyOps(state, [{ op: "fact.review", entity: "person", id: "I1", fid: "n1", status: "verified", note: "Matches the register", evidence: [{ title: "Parish register", source_type: "original" }] }]);
  assert.equal(n.state.people.I1.names[0].review.status, "verified");
  assert.equal(n.state.people.I1.names[0].citations.length, 1);
});

test("verifying a fact needs evidence; the review records it and adds new sources to the fact", async () => {
  let r = await edit({ ops: [{ op: "fact.review", entity: "person", id: pid, fid: ev.fid, status: "verified", note: "x" }] });
  if (!(ev.citations || []).length) assert.equal(r.status, 422, "no evidence, no verification");
  r = await edit({ ops: [{ op: "fact.review", entity: "person", id: pid, fid: ev.fid, status: "verified", note: "Matches the original register entry.",
    evidence: [{ title: "Leeds burial register", url: "https://example.org/burials/7", page: "entry 7", source_type: "original", information: "primary", evidence: "direct", quality: "3" }] }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const e = (await person()).events.find((x) => x.fid === ev.fid);
  assert.equal(e.review.status, "verified");
  assert.equal(e.review.by, EDITOR);
  assert.equal(e.review.evidence[0].quality, "3");
  assert.ok(e.citations.some((c) => c.url === "https://example.org/burials/7"), "new evidence is cited on the fact");
});

test("photos: attach with details, choose the main photo, update, and see it in the person's history", async () => {
  let r = await edit({ ops: [
    { op: "media.attach", person: pid, file: "uploads/2026-11/a.jpg", caption: "Wedding", type: "photo", date: "1956", place: "Leeds" },
    { op: "media.attach", person: pid, file: "uploads/2026-11/b.jpg", caption: "Headstone", type: "tombstone", portrait: true },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await edit({ ops: [{ op: "media.attach", person: pid, file: "uploads/x.jpg", type: "selfie" }] })).status, 422);
  r = await edit({ ops: [{ op: "media.set_primary", person: pid, file: "uploads/2026-11/a.jpg" }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let list = (await tree()).research.media[pid];
  assert.deepEqual(list.filter((m) => m.portrait).map((m) => m.file), ["uploads/2026-11/a.jpg"], "exactly one main photo");
  r = await edit({ ops: [{ op: "media.update", person: pid, file: "uploads/2026-11/b.jpg", set: { caption: "Headstone, Example Road", place: "", note: "Photographed by a cousin" } }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  list = (await tree()).research.media[pid];
  const b = list.find((m) => m.file.endsWith("b.jpg"));
  assert.equal(b.caption, "Headstone, Example Road");
  assert.equal(b.place, undefined, "an emptied field is removed");
  assert.equal(b.type, "tombstone");
  const h = (await call("GET", `/api/history?tree=all&id=${pid}`, { as: EDITOR })).data.history;
  const photoChange = h.find((x) => x.entities.some((e) => e.type === "media"));
  assert.ok(photoChange, "photo changes appear in the person's history");
  const ent = photoChange.entities.find((e) => e.type === "media");
  assert.ok(Array.isArray(ent.after) && ent.after.every((m) => m.file), "only this person's photos, as before/after lists");
});

test("media.detach with object unlinks an imported media item from one person only", () => {
  const mk = (id) => ({ id, names: [{ given: "Example", surname: "Sample", fid: "n1" }], sex: "M", famc: [], fams: [], events: [], notes: [], citations: [], media: ["O1", "O2"] });
  const state = { people: { A: mk("A"), B: mk("B") }, families: {}, sources: {}, media_map: {}, aliases: {} };
  const r = applyOps(state, [{ op: "media.detach", person: "A", object: "O1" }], { actor: EDITOR });
  assert.deepEqual(r.state.people.A.media, ["O2"]);
  assert.deepEqual(r.state.people.B.media, ["O1", "O2"], "another person's link is untouched");
  assert.deepEqual(state.people.A.media, ["O1", "O2"], "the input state isn't mutated");
  assert.deepEqual(r.touched.map((t) => [t.type, t.id]), [["person", "A"]]);
  assert.throws(() => applyOps(state, [{ op: "media.detach", person: "A", object: "O9" }], { actor: EDITOR }), OpError);
});

test("preview shows exactly what an edit would change, without saving it", async () => {
  const before = (await person()).events.length;
  const r = await call("POST", "/api/edit/preview", { as: MEMBER, body: { tree: "all", ops: [{ op: "event.add", entity: "person", id: pid, event: { type: "Residence", date: "1939", place: "Leeds" } }] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const t = r.data.touched.find((x) => x.type === "person" && x.id === pid);
  assert.equal(t.after.events.length, t.before.events.length + 1);
  assert.equal((await person()).events.length, before, "nothing saved");
  assert.equal((await call("POST", "/api/edit/preview", { as: MEMBER, body: { tree: "all", ops: [{ op: "event.remove", entity: "person", id: pid, fid: "e999" }] } })).status, 422);
});

test("findings: an edit resolves them in the same change; others are kept as is with a reason, or reopened", async () => {
  const f = (await tree()).research.findings.find((x) => x.person);
  assert.ok(f && f.id && f.version, "findings carry an id and version");
  const target = (await tree()).people[f.person];
  const fid = target.events.find((e) => e.fid).fid;
  // members can't resolve
  assert.equal((await call("PATCH", `/api/findings/${f.id}`, { as: MEMBER, body: { tree: "all", status: "dismissed", note: "no" } })).status, 403);
  // dismissing needs a reason
  assert.equal((await call("PATCH", `/api/findings/${f.id}`, { as: EDITOR, body: { tree: "all", status: "dismissed" } })).status, 400);
  // fix the tree and resolve the finding together
  let r = await edit({ reason: `Finding #${f.id}`, resolves: [f.id], ops: [{ op: "citation.add", entity: "person", id: f.person, fid, citation: { title: "Index entry", note: "From the finding", source_type: "derivative", information: "secondary", evidence: "direct", quality: "2" } }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let g = (await tree()).research.findings.find((x) => x.id === f.id);
  assert.equal(g.resolution.status, "resolved");
  assert.equal(g.resolution.batch, r.data.batch, "the resolution points at the change that fixed it");
  const hist = (await call("GET", `/api/history?tree=all&id=${f.person}`, { as: EDITOR })).data.history;
  const fixed = hist.find((x) => x.batch === r.data.batch);
  assert.equal(fixed.op, "edit");
  assert.ok(fixed.entities.some((e) => e.type === "finding") && fixed.entities.some((e) => e.type === "person"), "the fix and the resolution are one change");
  // undoing the fix reopens the finding
  const rv = await call("POST", `/api/changes/${r.data.batch}/revert?tree=all`, { as: EDITOR });
  assert.equal(rv.status, 200, JSON.stringify(rv.data));
  g = (await tree()).research.findings.find((x) => x.id === f.id);
  assert.equal(g.resolution, undefined, "undo reopened it");
  // resolve by hand, reopen, then keep as is with a reason
  r = await call("PATCH", `/api/findings/${f.id}`, { as: EDITOR, body: { tree: "all", status: "resolved", note: "Fixed in Ancestry", version: g.version } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  g = (await tree()).research.findings.find((x) => x.id === f.id);
  r = await call("PATCH", `/api/findings/${f.id}`, { as: EDITOR, body: { tree: "all", status: "open", version: g.version } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  g = (await tree()).research.findings.find((x) => x.id === f.id);
  assert.equal(g.resolution, undefined);
  r = await call("PATCH", `/api/findings/${f.id}`, { as: EDITOR, body: { tree: "all", status: "dismissed", note: "The register image shows the tree is right.", version: g.version } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // stale version is refused
  assert.equal((await call("PATCH", `/api/findings/${f.id}`, { as: EDITOR, body: { tree: "all", status: "open", version: g.version } })).status, 409);
  const h = (await call("GET", `/api/history?tree=all&id=${f.person}`, { as: EDITOR })).data.history;
  assert.ok(h.some((x) => x.op === "dismissed" && x.entities.some((e) => e.type === "finding")), "finding decisions are in the person's history");
});

test("research findings may carry structured targets and proposed edits, but not a resolution", async () => {
  const { validateBatch } = await import("../worker/research.js");
  const base = { person: pid, kind: "correction", confidence: "high", finding: "Register says 3 Mar 1931", sources: [{ title: "Register", note: "entry 7" }] };
  assert.deepEqual(validateBatch({ findings: [{ ...base, fact: "e2", proposed_ops: [{ op: "event.update", entity: "person", id: pid, fid: "e2", set: { date: "3 Mar 1931" } }] }] }, () => true), []);
  assert.match(validateBatch({ findings: [{ ...base, fact: "birth" }] }, () => true).join(), /fact must be/);
  assert.match(validateBatch({ findings: [{ ...base, proposed_ops: [{ op: "person.delete", id: pid }] }] }, () => true).join(), /may not delete/);
  assert.match(validateBatch({ findings: [{ ...base, resolution: { status: "resolved" } }] }, () => true).join(), /set by editors/);
});

test("GEDCOM export keeps citation quality, evidence analysis, reviews and photo types", async () => {
  const ged = (await call("GET", "/api/export.ged?tree=all", { as: OWNER })).data.replace(/\r\n/g, "\n"); // GEDCOM lines end in CRLF
  assert.match(ged, /\n3 QUAY 3\n/);
  assert.match(ged, /\n3 _SRCTYPE original\n/);
  assert.match(ged, /\n3 _INFO primary\n/);
  assert.match(ged, /\n3 _EVID direct\n/);
  assert.match(ged, /\n2 NOTE Verified by editor on \d{4}-\d{2}-\d{2}: Matches the original register entry\.\n/);
  assert.match(ged, /\n2 _STAT VERIFIED\n/);
  assert.match(ged, /\n3 TYPE tombstone\n/);
  assert.match(ged, /\n1 _PRIM Y\n/);
  assert.doesNotMatch(ged, /editor@example\.test/, "no reviewer email addresses in exports");
});
