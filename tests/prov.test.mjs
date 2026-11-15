// Provenance (PROV-O) over the change log: sources kept with each change, versions chained, agents and research
// runs attributed, scoped like History. Fictional example family only.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEnv, client, migrate } from "./helpers/fake-env.mjs";
import { changedFacts, factHistory } from "../worker/prov.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "owner@example.test", EDITOR = "editor@example.test", MEMBER = "member@example.test";
let env, call, pid, fid;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ft-prov-"));
  execFileSync("python3", ["tools/build.py", "--data", "example", "--out", dir, "--raw-out", join(dir, "raw.json")], { cwd: ROOT });
  const research = JSON.parse(readFileSync(join(ROOT, "example/research.json"), "utf8"));
  research.trees = [{ id: "all", name: "Everyone", definition: { branches: ["*"] } }];
  writeFileSync(join(dir, "research.json"), JSON.stringify(research));
  execFileSync("python3", ["tools/seed_app.py", "--raw", join(dir, "raw.json"), "--bundle", join(dir, "family.json"), "--research", join(dir, "research.json"), "--out", join(dir, "seed.sql"), "--owner", OWNER, "--cutover"], { cwd: ROOT });
  env = makeEnv({ AGENTS: { fetch: async () => new Response("{}", { status: 202 }) } });
  migrate(env.DB, ROOT);
  env.DB.execFile(join(dir, "seed.sql"));
  call = client((await import("../worker/index.js")).default, env);
  await call("PUT", "/api/admin/grants", { body: { principal: EDITOR, tree_id: "all", role: "editor" } });
  await call("PUT", "/api/admin/grants", { body: { principal: MEMBER, tree_id: "all", role: "member" } });
  const ex = JSON.parse(readFileSync(join(dir, "family.json"), "utf8"));
  pid = Object.values(ex.people).find((p) => !p.living && p.events.length >= 2).id;
  fid = (await call("GET", "/api/tree?tree=all", { as: EDITOR })).data.people[pid].events.find((e) => e.fid).fid;
});

const prov = async (as = EDITOR, q = `id=${pid}`) => {
  const res = await (await import("../worker/index.js")).default.fetch(new Request(`https://x.test/api/prov?tree=all&${q}`, { headers: { "X-Dev-Principal": as } }), env, {});
  return { status: res.status, type: res.headers.get("Content-Type"), doc: res.status === 200 ? await res.json() : null };
};
const nodes = (doc, type) => doc["@graph"].filter((n) => [].concat(n["@type"] || []).includes(type));

test("changedFacts names the facts a version touched", () => {
  const a = { events: [{ fid: "e1", type: "Birth", date: "1900" }, { fid: "e2", type: "Death" }], names: [{ fid: "n1", given: "A", surname: "B" }] };
  const b = { events: [{ fid: "e1", type: "Birth", date: "1901" }, { fid: "e3", type: "Burial", review: { status: "verified" } }], names: [{ fid: "n1", given: "A", surname: "B", citations: [{ title: "x" }] }] };
  assert.deepEqual(changedFacts(a, b).map((x) => `${x.fact}:${x.change}`).sort(), ["e1:updated", "e2:removed", "e3:added", "n1:cited"]);
});

test("edits keep their sources; provenance chains versions, agents and evidence", async () => {
  let r = await call("POST", "/api/edit", { as: EDITOR, body: { tree: "all", reason: "Register entry gives the place", sources: [{ title: "Example register", url: "https://example.org/r/1" }],
    ops: [{ op: "event.update", entity: "person", id: pid, fid, set: { place: "Hunslet, Leeds, Yorkshire, England" } }] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const batch = r.data.batch;
  const row = await env.DB.prepare("SELECT sources FROM changes WHERE batch_id = ?").bind(batch).first();
  assert.equal(JSON.parse(row.sources)[0].url, "https://example.org/r/1", "sources are stored with the change");
  r = await call("POST", "/api/edit", { as: EDITOR, body: { tree: "all", reason: "Second look", ops: [{ op: "event.update", entity: "person", id: pid, fid, set: { note: "checked" } }] } });
  assert.equal(r.status, 200);

  const { status, type, doc } = await prov();
  assert.equal(status, 200);
  assert.match(type, /application\/ld\+json/);
  assert.equal(doc["@context"].prov, "http://www.w3.org/ns/prov#");
  const act = doc["@graph"].find((n) => n["@id"] === `activity/${batch}`);
  assert.ok(act["@type"].includes("prov:Activity") && act["@type"].includes("ft:Edit"));
  assert.equal(act["rdfs:comment"], "Register entry gives the place");
  const editor = doc["@graph"].find((n) => n["@id"] === act["prov:wasAssociatedWith"]["@id"]);
  assert.ok(editor["@type"].includes("prov:Person"));
  assert.equal(editor["rdfs:label"], EDITOR);
  const versions = doc["@graph"].filter((n) => n["prov:specializationOf"] && n["prov:specializationOf"]["@id"] === `person/${pid}`);
  assert.ok(versions.length >= 2);
  const latest = versions[versions.length - 1];
  assert.ok(latest["prov:wasRevisionOf"], "each version revises the previous one");
  const v1 = versions.find((v) => v["prov:wasGeneratedBy"]["@id"] === `activity/${batch}`);
  const src = doc["@graph"].find((n) => n["@id"] === v1["prov:wasDerivedFrom"][0]["@id"]);
  assert.equal(src["ft:url"], "https://example.org/r/1", "the version is derived from the cited source");
  assert.ok(v1["ft:changedFacts"].some((f) => f.fact === fid && f.change === "updated"));
  const hist = factHistory(doc, fid);
  assert.equal(hist.length, 2);
  assert.equal(hist[0].reason, "Register entry gives the place");
  assert.equal(hist[0].sources[0].url, "https://example.org/r/1");
});

test("members see provenance without email addresses; strangers see nothing", async () => {
  const { doc } = await prov(MEMBER);
  assert.ok(!JSON.stringify(doc).includes("@example.test"), "no emails for members");
  assert.equal((await prov("nobody@example.test")).status, 403);
});

test("undo invalidates the undone version", async () => {
  const r = await call("POST", "/api/edit", { as: EDITOR, body: { tree: "all", reason: "mistake", ops: [{ op: "event.update", entity: "person", id: pid, fid, set: { note: "wrong" } }] } });
  const rv = await call("POST", `/api/changes/${r.data.batch}/revert?tree=all`, { as: EDITOR });
  assert.equal(rv.status, 200, JSON.stringify(rv.data));
  const { doc } = await prov();
  const undone = doc["@graph"].find((n) => n["prov:wasGeneratedBy"] && n["prov:wasGeneratedBy"]["@id"] === `activity/${r.data.batch}`);
  assert.equal(undone["prov:wasInvalidatedBy"]["@id"], `activity/${rv.data.batchId}`);
});

test("a research run acts on behalf of its starter, uses the pages it read, and generates its suggestion", async () => {
  const Runs = await import("../worker/agent/runs.js");
  const run = (await call("POST", "/api/agent/runs", { as: EDITOR, body: { tree: "all", person: pid, instructions: "Find the burial" } })).data.run;
  await Runs.markRunning(env, run.id);
  await Runs.recordUsed(env, run.id, { kind: "search", query: "burial register" });
  await Runs.recordUsed(env, run.id, { kind: "page", url: "https://example.org/burials/1", title: "Burials 1931" });
  const done = await Runs.submitResults(env, run.id, { summary: "Nothing found.", batch: { log: [{ person: pid, searched: "Example burials", result: "nil" }], agent: "cloud" } });
  const { doc } = await prov(EDITOR, `run=${run.id}`);
  const act = doc["@graph"].find((n) => n["@id"] === `run/${run.id}`);
  assert.ok(act["@type"].includes("ft:ResearchRun"));
  const cloud = doc["@graph"].find((n) => n["@id"] === act["prov:wasAssociatedWith"]["@id"]);
  assert.ok(cloud["@type"].includes("prov:SoftwareAgent"));
  assert.equal(doc["@graph"].find((n) => n["@id"] === cloud["prov:actedOnBehalfOf"]["@id"])["rdfs:label"], EDITOR);
  assert.deepEqual(act["prov:used"].map((u) => u["@id"]).filter((x) => x.startsWith("https://")), ["https://example.org/burials/1"]);
  assert.equal(act["prov:qualifiedAssociation"]["prov:hadPlan"]["rdfs:comment"], "Find the burial");
  const sugg = doc["@graph"].find((n) => n["@id"] === `proposal/${done.proposals[0]}`);
  assert.equal(sugg["prov:wasGeneratedBy"]["@id"], `run/${run.id}`);
  assert.equal((await prov(MEMBER, `run=${run.id}`)).status, 403, "runs are for editors");
});
