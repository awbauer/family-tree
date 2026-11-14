// tools/import_hints.py: a new GEDCOM export becomes edit proposals against the live tree.
//   node --test tests/hints.test.mjs
// Uses only the fictional family in example/. Needs python3.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HINTS = path.join(ROOT, "tools/import_hints.py");
const RESEARCH = path.join(ROOT, "example/research.json");
const DESTRUCTIVE = /\.(delete|remove|merge|swap_spouses)$|^person\.update$|^media\./;

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hints-"));
  const b = spawnSync("python3", [path.join(ROOT, "tools/build.py"), "--data", path.join(ROOT, "example"),
    "--out", tmp, "--raw-out", path.join(tmp, "raw.json")], { encoding: "utf8" });
  assert.equal(b.status, 0, b.stdout + b.stderr);
  const { raw, aliases } = JSON.parse(fs.readFileSync(path.join(tmp, "raw.json"), "utf8"));
  // the live database gives every event a stable fact id
  for (const e of [...Object.values(raw.people), ...Object.values(raw.families)]) {
    e.events.forEach((ev, i) => { ev.fid = `e${i + 1}`; });
  }
  const current = path.join(tmp, "current.json");
  fs.writeFileSync(current, JSON.stringify({ format: "family-tree-export/1", raw, config: { aliases } }));

  let ged = fs.readFileSync(path.join(ROOT, "example/example-family.ged"), "utf8");
  const sub = (from, to) => { assert.ok(ged.includes(from), `fixture anchor missing: ${from}`); ged = ged.replace(from, to); };
  // new source
  sub("0 @I1@ INDI", "0 @S4@ SOUR\n1 TITL Leeds Cemetery Burial Register (example)\n0 @I1@ INDI");
  // new burial on George Hartley (I4), citing the new source
  sub("1 OCCU Tram conductor", "1 BURI\n2 DATE 26 Nov 2004\n2 PLAC Leeds, Yorkshire, England\n2 SOUR @S4@\n3 PAGE Plot 12\n1 OCCU Tram conductor");
  // changed birth date for Manuel Costa (I6)
  sub("2 DATE 1 Apr 1935", "2 DATE 1 Apr 1936");
  // new person: a second child of George and Eva (family F2)
  sub("0 @F1@ FAM", "0 @I19@ INDI\n1 NAME Margaret /Hartley/\n2 GIVN Margaret\n2 SURN Hartley\n1 SEX F\n1 BIRT\n2 DATE 1962\n2 PLAC Leeds, Yorkshire, England\n1 FAMC @F2@\n0 @F1@ FAM");
  sub("1 CHIL @I2@", "1 CHIL @I2@\n1 CHIL @I19@");
  const gedPath = path.join(tmp, "new-export.ged");
  fs.writeFileSync(gedPath, ged);
  return { tmp, current, gedPath, ledger: path.join(tmp, "ledger.json") };
}

const run = promisify(execFile);
async function hints(env, args, extraEnv = {}) {
  const { stdout } = await run("python3", [HINTS, env.gedPath, "--current", env.current, "--research", RESEARCH,
    "--ledger", env.ledger, ...args], { env: { ...process.env, ...extraEnv }, encoding: "utf8" });
  return stdout;
}

function allOps(proposals) { return proposals.flatMap((p) => p.payload.ops); }

test("dry run suggests exactly the differences, never anything destructive", async () => {
  const env = setup();
  const out = path.join(env.tmp, "out.json");
  await hints(env, ["--dry-run", out]);
  const proposals = JSON.parse(fs.readFileSync(out, "utf8"));
  for (const p of proposals) {
    assert.equal(p.kind, "edit");
    assert.equal(p.payload.origin, "gedcom-hints:new-export.ged");
    assert.ok(p.payload.reason && p.rationale);
    assert.ok(p.payload.ops.length <= 25);
  }
  const ops = allOps(proposals);
  assert.deepEqual(ops.filter((o) => DESTRUCTIVE.test(o.op)), []);

  const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === "explanation" ? undefined : v)));
  const got = ops.map(strip).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const want = [
    { op: "source.upsert", id: "S4", data: { title: "Leeds Cemetery Burial Register (example)" } },
    { op: "person.create", id: "I19", names: [{ given: "Margaret", surname: "Hartley" }], sex: "F",
      events: [{ type: "Birth", date: "1962", place: "Leeds, Yorkshire, England" }] },
    { op: "family.add_child", family: "F2", person: "I19" },
    { op: "event.add", entity: "person", id: "I4",
      event: { type: "Burial", date: "26 Nov 2004", place: "Leeds, Yorkshire, England",
        citations: [{ source: "S4", page: "Plot 12" }] } },
    { op: "event.update", entity: "person", id: "I6", fid: "e1", set: { date: "1 Apr 1936" }, conflict: true },
  ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert.deepEqual(got, want);

  // the conflict is alone in a proposal flagged as such, with an explanation
  const conflicts = proposals.filter((p) => p.rationale.startsWith("CONFLICT:"));
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].payload.ops.map((o) => o.op), ["event.update"]);
  assert.match(conflicts[0].payload.ops[0].explanation, /1 Apr 1935/);
  assert.ok(proposals.filter((p) => !p.rationale.startsWith("CONFLICT:")).every((p) => p.payload.ops.every((o) => !o.conflict)));

  // the new person and their family link travel together; the burial's source travels with the burial
  const create = proposals.find((p) => p.payload.ops.some((o) => o.op === "person.create"));
  assert.deepEqual(create.payload.ops.map((o) => o.op), ["person.create", "family.add_child"]);
  const burial = proposals.find((p) => p.payload.ops.some((o) => o.op === "event.add"));
  assert.deepEqual(burial.payload.ops.map((o) => o.op), ["source.upsert", "event.add"]);

  // nothing for unchanged people or families
  const touched = new Set(ops.flatMap((o) => [o.id, o.person, o.family].filter(Boolean)));
  assert.deepEqual([...touched].sort(), ["F2", "I19", "I4", "I6", "S4"].sort());
});

test("unchanged export suggests nothing", async () => {
  const env = setup();
  env.gedPath = path.join(ROOT, "example/example-family.ged");
  const out = path.join(env.tmp, "same.json");
  await hints(env, ["--dry-run", out]);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")), []);
});

test("--submit posts each proposal once; the ledger makes re-runs idempotent", async () => {
  const env = setup();
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      received.push({ method: req.method, url: req.url, principal: req.headers["x-dev-principal"], body: JSON.parse(body || "{}") });
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ proposal: { id: received.length } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const ftEnv = { FT_URL: `http://127.0.0.1:${server.address().port}`, FT_TREE: "example", FT_DEV_PRINCIPAL: "agent:hints-test" };
  try {
    await hints(env, ["--submit"], ftEnv);
    assert.equal(received.length, 3);
    for (const r of received) {
      assert.equal(r.method, "POST");
      assert.equal(r.url, "/api/proposals?tree=example");
      assert.equal(r.principal, "agent:hints-test");
      assert.equal(r.body.tree, "example");
      assert.equal(r.body.kind, "edit");
    }
    const ledger = JSON.parse(fs.readFileSync(env.ledger, "utf8"));
    assert.equal(Object.keys(ledger.ops).length, 5);

    await hints(env, ["--submit"], ftEnv);
    assert.equal(received.length, 3, "second run must not submit anything");
    const out = path.join(env.tmp, "again.json");
    const stdout = await hints(env, ["--dry-run", out]);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")), []);
    assert.match(stdout, /already submitted/);
  } finally {
    server.close();
  }
});
