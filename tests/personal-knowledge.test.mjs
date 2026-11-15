// Facts the editor knows themselves: a "personal knowledge" citation needs no document, is credited to the person
// entering it (never to whoever the request names, never to an agent), and counts as evidence for verifying a fact.
// Fictional example family only.
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
const OWNER = "owner@example.test", EDITOR = "editor@example.test";
let call, env;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ft-pk-"));
  execFileSync("python3", ["tools/build.py", "--data", "example", "--out", dir, "--raw-out", join(dir, "raw.json")], { cwd: ROOT });
  const research = JSON.parse(readFileSync(join(ROOT, "example/research.json"), "utf8"));
  research.trees = [{ id: "all", name: "Everyone", definition: { branches: ["*"] } }];
  writeFileSync(join(dir, "research.json"), JSON.stringify(research));
  execFileSync("python3", ["tools/seed_app.py", "--raw", join(dir, "raw.json"), "--bundle", join(dir, "family.json"), "--research", join(dir, "research.json"), "--out", join(dir, "seed.sql"), "--owner", OWNER, "--cutover"], { cwd: ROOT });
  env = makeEnv();
  migrate(env.DB, ROOT);
  env.DB.execFile(join(dir, "seed.sql"));
  call = client((await import("../worker/index.js")).default, env);
  await call("PUT", "/api/admin/grants", { body: { principal: EDITOR, tree_id: "all", role: "editor" } });
});

const state = () => ({ people: { P1: { id: "P1", names: [{ given: "Example", surname: "Person" }], events: [{ fid: "e1", type: "Birth", date: "1950" }], famc: [], fams: [] } }, families: {}, sources: {}, media_map: {}, aliases: {} });

test("credited to the person entering it, dated, and needs nothing else", () => {
  const r = applyOps(state(), [{ op: "event.add", entity: "person", id: "P1", event: { type: "Occupation", value: "Example work", citations: [{ personal: true, by: "someone-else@example.test", note: "I worked with her" }] } }], { actor: EDITOR, now: "2026-05-01T10:00:00Z" });
  const ev = r.state.people.P1.events.find((e) => e.type === "Occupation");
  assert.deepEqual(ev.citations, [{ personal: true, title: "Personal knowledge", by: EDITOR, accessed: "2026-05-01", note: "I worked with her" }], "the request can't name someone else");
});

test("an agent applying a change for someone credits them; an agent can't claim knowledge itself", () => {
  const ops = [{ op: "citation.add", entity: "person", id: "P1", fid: "e1", citation: { personal: true } }];
  const r = applyOps(state(), ops, { actor: "agent:assistant", knower: OWNER });
  assert.equal(r.state.people.P1.events[0].citations[0].by, OWNER);
  assert.throws(() => applyOps(state(), ops, { actor: "agent:cloud" }), OpError);
  assert.throws(() => applyOps(state(), ops, { actor: "service:research" }), OpError);
});

test("it counts as evidence: a fact can be verified from personal knowledge alone", async () => {
  const pid = "I5";
  const fid = (await call("GET", "/api/tree?tree=all")).data.people[pid].events.find((e) => e.type === "Birth").fid;
  const r = await call("POST", "/api/edit", { as: EDITOR, body: { tree: "all", reason: "I was there", ops: [{ op: "fact.review", entity: "person", id: pid, fid, status: "verified", note: "Family knowledge", evidence: [{ personal: true }] }] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const ev = (await call("GET", "/api/tree?tree=all", { as: EDITOR })).data.people[pid].events.find((e) => e.fid === fid);
  assert.equal(ev.review.status, "verified");
  assert.equal(ev.review.evidence[0].personal, true);
  assert.equal(ev.review.evidence[0].by, EDITOR);
  // the change is in the history like any other, credited to the editor
  const h = await call("GET", `/api/history?tree=all&person=${pid}`, { as: EDITOR });
  assert.equal(h.status, 200);
  // and the GEDCOM export names it as a source
  const ged = await call("GET", "/api/export.ged?tree=all");
  assert.match(typeof ged.data === "string" ? ged.data : ged.text || JSON.stringify(ged.data), /Personal knowledge/);
});
