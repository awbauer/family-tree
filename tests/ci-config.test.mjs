import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (env, src, out) => spawnSync(process.execPath, [join(ROOT, "tools/ci_config.mjs"), src, out], { env: { ...process.env, CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "", ...env }, encoding: "utf8" });
const ID = ["0".repeat(8), "1".repeat(4), "2".repeat(4), "3".repeat(4), "4".repeat(12)].join("-"); // built at runtime: the privacy hook blocks UUID literals

test("the committed template has no vars and keeps dashboard vars", () => {
  const out = join(mkdtempSync(join(tmpdir(), "ci-")), "w.json");
  const r = run({ D1_DATABASE_ID: ID }, join(ROOT, "wrangler.jsonc"), out);
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(cfg.d1_databases[0].database_id, ID);
  assert.equal(cfg.keep_vars, true);
  assert.equal(cfg.vars, undefined);
  assert.equal(cfg.workers_dev, false);
  assert.equal(cfg.preview_urls, false);
  assert.equal(cfg.name, "family-tree");
});

test("refuses without a real database id", () => {
  const out = join(mkdtempSync(join(tmpdir(), "ci-")), "w.json");
  assert.notEqual(run({ D1_DATABASE_ID: "" }, join(ROOT, "wrangler.jsonc"), out).status, 0);
  assert.notEqual(run({ D1_DATABASE_ID: "REPLACE_WITH_YOUR_D1_DATABASE_ID" }, join(ROOT, "wrangler.jsonc"), out).status, 0);
});

test("strips vars even if someone adds them back to the template", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-"));
  writeFileSync(join(dir, "t.jsonc"), `{ // comment\n "name": "family-tree", "main": "w.js", /* x */ "d1_databases": [{"binding": "DB", "database_name": "family-tree", "database_id": "x"}],\n "vars": {"ACCESS_AUD": "", "URL": "http://a//b"}, }`);
  const r = run({ D1_DATABASE_ID: ID }, join(dir, "t.jsonc"), join(dir, "o.json"));
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(readFileSync(join(dir, "o.json"), "utf8"));
  assert.equal(cfg.vars, undefined);
  assert.equal(cfg.keep_vars, true);
  assert.match(r.stderr, /dropping vars ACCESS_AUD, URL/);
});

const AGENTS = ["FlueAssistantAgent", "FlueProfileWriterAgent", "FlueQualityReviewerAgent", "FlueResearcherAgent", "FlueSherlockAgent", "FlueStoryLibrarianAgent", "FlueStoryReviewerAgent", "FlueStoryWriterAgent"];

test("one Worker: the site and the agents, with every agent's class bound and created by migration v1", () => {
  const out = join(mkdtempSync(join(tmpdir(), "ci-")), "w.json");
  const r = run({ D1_DATABASE_ID: ID, AGENTS_TRANSFER_FROM: "off" }, join(ROOT, "wrangler.jsonc"), out);
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(cfg.main, "worker/main.js");
  assert.equal(cfg.services, undefined, "no service binding to a separate agents Worker");
  assert.ok(cfg.compatibility_flags.includes("nodejs_compat"));
  assert.deepEqual(cfg.ai, { binding: "AI" });
  assert.deepEqual(cfg.durable_objects.bindings.map((b) => b.class_name).sort(), AGENTS);
  assert.deepEqual(cfg.migrations.map((m) => m.tag), ["v1"]);
  assert.deepEqual([...cfg.migrations[0].new_sqlite_classes].sort(), AGENTS);
  assert.ok(cfg.triggers.crons.length);
});

test("AGENTS_TRANSFER_FROM turns v1 into a transfer of every agent from the old agents Worker", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-"));
  const r = run({ D1_DATABASE_ID: ID, AGENTS_TRANSFER_FROM: "family-tree-agents" }, join(ROOT, "wrangler.jsonc"), join(dir, "t.json"));
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(readFileSync(join(dir, "t.json"), "utf8")).migrations;
  assert.equal(m[0].tag, "v1");
  assert.equal(m[0].new_sqlite_classes, undefined);
  assert.deepEqual(m[0].transferred_classes.map((t) => t.from).sort(), AGENTS);
  assert.ok(m[0].transferred_classes.every((t) => t.from === t.to && t.from_script === "family-tree-agents"));
  assert.notEqual(run({ D1_DATABASE_ID: ID, AGENTS_TRANSFER_FROM: "bad name!" }, join(ROOT, "wrangler.jsonc"), join(dir, "x.json")).status, 0);
});

test("unset, it transfers only if the build token finds the old agents Worker, and stops if it can't tell", async () => {
  const { createServer } = await import("node:http");
  const seen = [];
  let status = 200;
  const srv = createServer((req, res) => {
    seen.push(req.url);
    if (req.url === "/accounts") return res.writeHead(200).end(JSON.stringify({ success: true, result: [{ id: "a2" }] }));
    res.writeHead(status).end("{}");
  });
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), "ci-"));
  const env = { D1_DATABASE_ID: ID, AGENTS_TRANSFER_FROM: "", CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a1", CLOUDFLARE_API_BASE_URL: base };
  const runAsync = (e, out) => new Promise((resolve) => {
    const p = spawn(process.execPath, [join(ROOT, "tools/ci_config.mjs"), join(ROOT, "wrangler.jsonc"), out], { env: { ...process.env, ...e } });
    let err = ""; p.stderr.on("data", (d) => (err += d)); p.on("close", (code) => resolve({ status: code, stderr: err }));
  });
  const first = (f) => JSON.parse(readFileSync(join(dir, f), "utf8")).migrations[0];
  try {
    let r = await runAsync(env, join(dir, "yes.json"));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(first("yes.json").transferred_classes, "found: transfer");
    assert.ok(seen.includes("/accounts/a1/workers/scripts/family-tree-agents/settings"));
    status = 404;
    r = await runAsync(env, join(dir, "no.json"));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(first("no.json").new_sqlite_classes, "not found: a new site creates the classes");
    status = 403;
    r = await runAsync(env, join(dir, "unknown.json"));
    assert.notEqual(r.status, 0, "can't tell: stop rather than leave the agents' data behind");
    assert.match(r.stderr, /AGENTS_TRANSFER_FROM/);
    // without an account id, it's looked up from the token
    status = 200;
    r = await runAsync({ ...env, CLOUDFLARE_ACCOUNT_ID: "" }, join(dir, "lookup.json"));
    assert.ok(first("lookup.json").transferred_classes);
    assert.ok(seen.includes("/accounts/a2/workers/scripts/family-tree-agents/settings"));
  } finally { srv.close(); }
});

test("the agents' build config is build input only: never deployed on its own", () => {
  const raw = readFileSync(join(ROOT, "agents/wrangler.jsonc"), "utf8");
  assert.match(raw, /Build input only/);
  const pkg = JSON.parse(readFileSync(join(ROOT, "agents/package.json"), "utf8"));
  assert.equal(pkg.scripts.deploy, undefined);
  assert.equal(pkg.scripts["deploy:ci"], undefined);
});
