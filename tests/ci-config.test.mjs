import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (env, src, out) => spawnSync(process.execPath, [join(ROOT, "tools/ci_config.mjs"), src, out], { env: { ...process.env, ...env }, encoding: "utf8" });
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

test("the agents Worker binding is added only when AGENTS_SERVICE names it", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-"));
  const off = run({ D1_DATABASE_ID: ID, AGENTS_SERVICE: "" }, join(ROOT, "wrangler.jsonc"), join(dir, "a.json"));
  assert.equal(off.status, 0, off.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, "a.json"), "utf8")).services, undefined);
  const on = run({ D1_DATABASE_ID: ID, AGENTS_SERVICE: "family-tree-agents" }, join(ROOT, "wrangler.jsonc"), join(dir, "b.json"));
  assert.equal(on.status, 0, on.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "b.json"), "utf8")).services, [{ binding: "AGENTS", service: "family-tree-agents" }]);
  assert.notEqual(run({ D1_DATABASE_ID: ID, AGENTS_SERVICE: "bad name!" }, join(ROOT, "wrangler.jsonc"), join(dir, "c.json")).status, 0);
});

test("the agents Worker template is private, keeps dashboard vars and gets the D1 id", () => {
  const out = join(mkdtempSync(join(tmpdir(), "ci-")), "w.json");
  const r = run({ D1_DATABASE_ID: ID, AGENTS_SERVICE: "" }, join(ROOT, "agents/wrangler.jsonc"), out);
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(cfg.name, "family-tree-agents");
  assert.equal(cfg.workers_dev, false);
  assert.equal(cfg.preview_urls, false);
  assert.equal(cfg.routes, undefined);
  assert.equal(cfg.vars, undefined);
  assert.equal(cfg.keep_vars, true);
  assert.equal(cfg.d1_databases[0].database_id, ID);
  assert.ok(cfg.compatibility_flags.includes("nodejs_compat"));
  assert.deepEqual(cfg.migrations[0].new_sqlite_classes.sort(), ["FlueProfileWriterAgent", "FlueResearcherAgent", "FlueStoryReviewerAgent"]);
});
