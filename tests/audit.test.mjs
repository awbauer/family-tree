// The audit history (owner only): every change, for all trees and the sharing settings, grouped by batch, filterable,
// paged, with each batch's full before/after on request. Fictional example family only.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEnv, client, migrate } from "./helpers/fake-env.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "owner@example.test", EDITOR = "editor@example.test";
let env, call, pid, batch;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ft-aud-"));
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
  const ex = JSON.parse(readFileSync(join(dir, "family.json"), "utf8"));
  pid = Object.values(ex.people).find((p) => !p.living && p.events.length >= 2).id;
  const fid = (await call("GET", "/api/tree?tree=all", { as: EDITOR })).data.people[pid].events[0].fid;
  const r = await call("POST", "/api/edit", { as: EDITOR, body: { tree: "all", reason: "Example register gives the place", sources: [{ title: "Example register" }],
    ops: [{ op: "event.update", entity: "person", id: pid, fid, set: { note: "Example note" } }, { op: "person.update", id: pid, set: { notes: ["Example"] } }] } });
  batch = r.data.batch;
  for (let i = 0; i < 5; i++) await call("POST", "/api/todos", { as: EDITOR, body: { tree: "all", task: `Example task ${i}`, priority: "low" } });
});

test("only the owner sees the audit history", async () => {
  assert.equal((await call("GET", "/api/admin/audit?tree=all", { as: EDITOR })).status, 403);
  assert.equal((await call("GET", `/api/admin/audit/${batch}?tree=all`, { as: EDITOR })).status, 403);
});

test("changes come grouped by batch, newest first, with who, what and why", async () => {
  const r = await call("GET", "/api/admin/audit?tree=all&limit=100");
  assert.equal(r.status, 200);
  const b = r.data.batches.find((x) => x.batch === batch);
  assert.ok(b, "the edit is listed");
  assert.equal(b.actor, EDITOR);
  assert.equal(b.op, "edit");
  assert.equal(b.reason, "Example register gives the place");
  assert.ok(b.types.person >= 1);
  assert.ok(b.entities.some((e) => e.type === "person" && e.id === pid && e.label));
  assert.ok(r.data.batches.some((x) => "grant" in x.types), "sharing changes are in it too");
  const at = r.data.batches.map((x) => Date.parse(x.at));
  assert.ok(at.every((t, i) => i === 0 || t <= at[i - 1]), "newest first");
  assert.ok(r.data.actors.some((a) => a.v === EDITOR) && r.data.types.some((t) => t.v === "todo"), "filter choices");
});

test("filters and paging", async () => {
  const todos = await call("GET", "/api/admin/audit?tree=all&type=todo&limit=2");
  assert.equal(todos.data.batches.length, 2);
  assert.ok(todos.data.batches.every((x) => Object.keys(x.types).join() === "todo"));
  assert.ok(todos.data.next, "there is another page");
  const page2 = await call("GET", `/api/admin/audit?tree=all&type=todo&limit=2&before=${todos.data.next}`);
  assert.equal(page2.data.batches.length, 2);
  assert.ok(!page2.data.batches.some((x) => todos.data.batches.some((y) => y.key === x.key)), "no repeats across pages");
  const q = await call("GET", "/api/admin/audit?tree=all&q=register");
  assert.ok(q.data.batches.length >= 1 && q.data.batches.every((x) => /register/i.test(x.reason || "")));
  const byActor = await call("GET", `/api/admin/audit?tree=all&actor=${encodeURIComponent(OWNER)}`);
  assert.ok(byActor.data.batches.length >= 1 && byActor.data.batches.every((x) => x.actor === OWNER || x.on_behalf_of === OWNER));
});

test("a batch's detail has the full before and after of each record", async () => {
  const r = await call("GET", `/api/admin/audit/${batch}?tree=all`);
  assert.equal(r.status, 200);
  const row = r.data.rows.find((x) => x.type === "person" && x.entity === pid);
  assert.equal(row.change, "updated");
  assert.ok(row.before && row.after);
  assert.deepEqual(row.after.notes, ["Example"]);
  assert.equal(row.sources[0].title, "Example register");
  assert.equal((await call("GET", "/api/admin/audit/bnosuchbatch?tree=all")).status, 404);
  const single = (await call("GET", "/api/admin/audit?tree=all&type=todo&limit=1")).data.batches[0];
  const d = await call("GET", `/api/admin/audit/${single.key}?tree=all`);
  assert.equal(d.status, 200);
  assert.equal(d.data.rows[0].type, "todo");
});
