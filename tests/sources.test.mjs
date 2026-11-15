// Catalogued sources: source.upsert (type, transcription, clearing fields), source.merge (re-point every citation in
// one undoable batch), source.delete (only when uncited), and who may do what. Fictional example family only.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEnv, client, migrate } from "./helpers/fake-env.mjs";
import { applyOps, forEachSourceUse, referencedIds, OpError } from "../worker/ops.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "owner@example.test", EDITOR = "editor@example.test", MEMBER = "member@example.test", NARROW = "narrow@example.test";
let env, call, research;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ft-src-"));
  execFileSync("python3", ["tools/build.py", "--data", "example", "--out", dir, "--raw-out", join(dir, "raw.json")], { cwd: ROOT });
  research = JSON.parse(readFileSync(join(ROOT, "example/research.json"), "utf8"));
  research.trees = [{ id: "all", name: "Everyone", definition: { branches: ["*"] } }, { id: "one", name: "One branch", definition: { branches: [research.branches[0].key] } }];
  writeFileSync(join(dir, "research.json"), JSON.stringify(research));
  execFileSync("python3", ["tools/seed_app.py", "--raw", join(dir, "raw.json"), "--bundle", join(dir, "family.json"), "--research", join(dir, "research.json"), "--out", join(dir, "seed.sql"), "--owner", OWNER, "--cutover"], { cwd: ROOT });
  env = makeEnv();
  migrate(env.DB, ROOT);
  env.DB.execFile(join(dir, "seed.sql"));
  call = client((await import("../worker/index.js")).default, env);
  await call("PUT", "/api/admin/grants", { body: { principal: EDITOR, tree_id: "all", role: "editor" } });
  await call("PUT", "/api/admin/grants", { body: { principal: MEMBER, tree_id: "all", role: "member" } });
  await call("PUT", "/api/admin/grants", { body: { principal: NARROW, tree_id: "one", role: "editor" } });
});

const tree = async (as = EDITOR, t = "all") => (await call("GET", `/api/tree?tree=${t}`, { as })).data;
const edit = (body, as = EDITOR, t = "all") => call("POST", "/api/edit", { as, body: { tree: t, reason: "test", ...body } });
const revert = (batch, as = EDITOR) => call("POST", `/api/changes/${batch}/revert`, { as });
/** Every citation of a source in a tree: [{owner, fid}] (person and family facts, person-level, review evidence). */
function usesOf(D, sid) {
  const out = [];
  forEachSourceUse({ people: D.people, families: D.families, media_map: D.research.media }, sid, (kind, owner) => out.push(`${kind}:${owner}`));
  return out;
}

// ---------------------------------------------------------------- the op engine
const STATE = () => ({
  people: {
    I1: { id: "I1", names: [{ fid: "n1", given: "Example", surname: "Name", citations: [{ source: "SB" }] }], famc: [], fams: ["F1"], citations: [{ source: "SB", page: "p. 2" }],
      events: [{ fid: "e1", type: "Birth", date: "1880", citations: [{ source: "SB", page: "entry 4" }, { source: "SA" }], review: { status: "verified", evidence: [{ source: "SB", page: "entry 4" }] } }] },
    I2: { id: "I2", names: [{ fid: "n1", given: "Other", surname: "Exampleton" }], famc: [], fams: ["F1"], events: [], citations: [] },
  },
  families: { F1: { id: "F1", husband: "I1", wife: "I2", children: [], events: [{ fid: "e1", type: "Marriage", citations: [{ source: "SB" }] }] } },
  sources: { SA: { id: "SA", title: "Exampleton parish register" }, SB: { id: "SB", title: "Exampleton register (copy)", url: "https://example.test/register", text: "Example Name, born 1880" }, SC: { id: "SC", title: "Unused" } },
  media_map: { I1: [{ file: "uploads/a.jpg", source: "SB" }, { file: "uploads/b.jpg" }] },
  aliases: {},
});

test("source.merge re-points every citation, review evidence and photo, fills empty fields, and removes the duplicate", () => {
  const s0 = STATE();
  const { state, touched } = applyOps(s0, [{ op: "source.merge", keep: "SA", drop: "SB" }], { actor: "t" });
  assert.equal(forEachSourceUse(state, "SB"), 0);
  assert.equal(forEachSourceUse(state, "SA"), 7); // its own one, plus the six of SB: person, name, birth, its review, family, photo
  assert.equal(state.sources.SB, undefined);
  assert.equal(state.people.I1.events[0].citations[0].page, "entry 4", "citation details are kept");
  assert.equal(state.people.I1.events[0].review.evidence[0].source, "SA");
  assert.equal(state.families.F1.events[0].citations[0].source, "SA");
  assert.equal(state.media_map.I1[0].source, "SA");
  assert.equal(state.sources.SA.title, "Exampleton parish register", "the survivor's own fields win");
  assert.equal(state.sources.SA.url, "https://example.test/register", "empty fields are filled from the duplicate");
  assert.deepEqual(touched.map((t) => `${t.type}:${t.id}`).sort(), ["family:F1", "media_map:I1", "person:I1", "source:SA", "source:SB"]);
  assert.equal(forEachSourceUse(s0, "SB"), 6, "the input is not mutated");
  assert.throws(() => applyOps(STATE(), [{ op: "source.merge", keep: "SA", drop: "SA" }]), /same source/);
  assert.throws(() => applyOps(STATE(), [{ op: "source.merge", keep: "SA", drop: "SX" }]), OpError);
  assert.deepEqual([...referencedIds([{ op: "source.merge", keep: "SA", drop: "SB" }]).people], [], "source ids aren't taken for people");
});

test("source.delete refuses a source that is still cited (even only by a photo), and removes an uncited one", () => {
  assert.throws(() => applyOps(STATE(), [{ op: "source.delete", id: "SB" }]), /still cited 6 times/);
  const s = STATE();
  s.media_map.I2 = [{ file: "uploads/c.jpg", source: "SC" }];
  assert.throws(() => applyOps(s, [{ op: "source.delete", id: "SC" }]), /still cited 1 time;/);
  const { state } = applyOps(STATE(), [{ op: "source.delete", id: "SC" }]);
  assert.equal(state.sources.SC, undefined);
  const merged = applyOps(STATE(), [{ op: "source.merge", keep: "SA", drop: "SB" }, { op: "source.delete", id: "SC" }]).state;
  assert.deepEqual(Object.keys(merged.sources), ["SA"]);
});

test("source.upsert keeps type, transcription and repository, validates them, and clears fields given empty", () => {
  const { state } = applyOps(STATE(), [{ op: "source.upsert", id: "SB", data: { type: "derivative", repository: "Exampleton record office", url: "" } }]);
  assert.deepEqual(state.sources.SB, { id: "SB", title: "Exampleton register (copy)", text: "Example Name, born 1880", type: "derivative", repository: "Exampleton record office" });
  assert.throws(() => applyOps(STATE(), [{ op: "source.upsert", id: "SB", data: { type: "rumour" } }]), /source type must be one of/);
  assert.throws(() => applyOps(STATE(), [{ op: "source.upsert", id: "SB", data: { url: "ftp://x" } }]), /http/);
  assert.throws(() => applyOps(STATE(), [{ op: "source.upsert", id: "SB", data: { title: "" } }]), /needs a title/);
  assert.throws(() => applyOps(STATE(), [{ op: "source.upsert", data: { author: "Someone" } }]), /needs a title/);
});

// ---------------------------------------------------------------- through the API
test("the tree lists every source with how often it's cited, including uncited ones", async () => {
  const D = await tree();
  assert.ok(Object.keys(D.sources).length >= 3);
  const r = await edit({ ops: [{ op: "source.upsert", id: "S90", data: { title: "Exampleton almanac", type: "book" } }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const D2 = await tree();
  assert.equal(D2.sources.S90.title, "Exampleton almanac", "an uncited source is still listed");
  assert.equal(usesOf(D2, "S90").length, 0);
  for (const sid of Object.keys(D.sources)) if (sid !== "S90") assert.ok(usesOf(D, sid).length > 0, `${sid} is cited`);
});

test("editing a source shows everywhere it's cited, is in the audit history, and can be undone", async () => {
  const D = await tree();
  const [sid] = Object.keys(D.sources).filter((k) => usesOf(D, k).length);
  const old = D.sources[sid].title;
  const r = await edit({ reason: "fix the collection title", ops: [{ op: "source.upsert", id: sid, data: { title: "Exampleton census (corrected)", type: "original", text: "Example Name, 40, farmer" } }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const D2 = await tree();
  assert.equal(D2.sources[sid].title, "Exampleton census (corrected)");
  assert.equal(D2.sources[sid].text, "Example Name, 40, farmer");
  const audit = await call("GET", "/api/admin/audit?tree=all&limit=100", { as: OWNER });
  const b = audit.data.batches.find((x) => x.batch === r.data.batch);
  assert.ok(b && b.reason === "fix the collection title" && b.types.source === 1);
  assert.equal((await revert(r.data.batch)).status, 200);
  assert.equal((await tree()).sources[sid].title, old);
});

test("merging two sources moves all their citations in one batch; one undo restores both", async () => {
  const D = await tree();
  const cited = Object.keys(D.sources).filter((k) => usesOf(D, k).length).sort((a, b) => usesOf(D, b).length - usesOf(D, a).length);
  const [keep, drop] = cited;
  const before = { keep: usesOf(D, keep), drop: usesOf(D, drop) };
  assert.ok(before.drop.length > 0);
  const r = await edit({ reason: "the same collection twice", ops: [{ op: "source.merge", keep, drop }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const D2 = await tree();
  assert.equal(D2.sources[drop], undefined);
  assert.equal(usesOf(D2, drop).length, 0);
  assert.deepEqual(usesOf(D2, keep).sort(), [...before.keep, ...before.drop].sort());
  const rows = (await call("GET", `/api/admin/audit/${r.data.batch}?tree=all`, { as: OWNER })).data.rows;
  assert.ok(rows.some((x) => x.type === "source" && x.entity === drop && x.change === "deleted"));
  assert.ok(rows.every((x) => x.reason === "the same collection twice"));
  const rv = await revert(r.data.batch);
  assert.equal(rv.status, 200, JSON.stringify(rv.data));
  const D3 = await tree();
  assert.deepEqual(D3.sources[drop], D.sources[drop]);
  assert.deepEqual(D3.sources[keep], D.sources[keep]);
  assert.deepEqual(usesOf(D3, keep).sort(), before.keep.sort());
  assert.deepEqual(usesOf(D3, drop).sort(), before.drop.sort());
});

test("a cited source can't be deleted; an uncited one can, and the delete can be undone", async () => {
  const D = await tree();
  const cited = Object.keys(D.sources).find((k) => usesOf(D, k).length);
  const no = await edit({ ops: [{ op: "source.delete", id: cited }] });
  assert.equal(no.status, 422);
  assert.match(no.data.error, /still cited/);
  await edit({ ops: [{ op: "source.upsert", id: "S91", data: { title: "Exampleton directory" } }] });
  const r = await edit({ reason: "never used", ops: [{ op: "source.delete", id: "S91" }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await tree()).sources.S91, undefined);
  assert.equal((await revert(r.data.batch)).status, 200);
  assert.equal((await tree()).sources.S91.title, "Exampleton directory");
});

test("members suggest source changes; an editor's approval applies them", async () => {
  const D = await tree(MEMBER);
  const sid = Object.keys(D.sources)[0];
  assert.equal((await edit({ ops: [{ op: "source.upsert", id: sid, data: { repository: "Exampleton library" } }] }, MEMBER)).status, 403);
  const pr = await call("POST", "/api/proposals", { as: MEMBER, body: { tree: "all", kind: "edit", rationale: "seen there", payload: { reason: "seen there", ops: [{ op: "source.upsert", id: sid, data: { repository: "Exampleton library" } }] } } });
  assert.equal(pr.status, 201, JSON.stringify(pr.data));
  const bad = await call("POST", "/api/proposals", { as: MEMBER, body: { tree: "all", kind: "edit", payload: { reason: "x", ops: [{ op: "source.merge", keep: sid, drop: sid }] } } });
  assert.equal(bad.status, 422, "suggestions are validated too");
  assert.equal((await call("POST", `/api/proposals/${pr.data.proposal.id}/approve`, { as: EDITOR })).status, 200);
  assert.equal((await tree()).sources[sid].repository, "Exampleton library");
});

test("an editor of one branch can't merge away a source cited outside it", async () => {
  const narrow = await tree(NARROW, "one"), all = await tree(OWNER);
  const inside = Object.keys(narrow.people)[0], outside = Object.keys(all.people).find((k) => !narrow.people[k]);
  assert.ok(inside && outside);
  const cite = (pid, s) => ({ op: "citation.add", entity: "person", id: pid, citation: { source: s } });
  const r = await edit({ ops: [{ op: "source.upsert", id: "S92", data: { title: "Exampleton tax list" } }, { op: "source.upsert", id: "S93", data: { title: "Exampleton tax list (copy)" } },
    cite(inside, "S92"), cite(outside, "S92"), cite(inside, "S93")] }, OWNER);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const no = await edit({ ops: [{ op: "source.merge", keep: "S93", drop: "S92" }] }, NARROW, "one");
  assert.equal(no.status, 403, JSON.stringify(no.data));
  const ok = await edit({ ops: [{ op: "source.merge", keep: "S92", drop: "S93" }] }, NARROW, "one");
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
});
