import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// a fake wrangler: prints a scripted sequence of outputs, one per call
function fake(outputs, code = 0) {
  const dir = mkdtempSync(join(tmpdir(), "wm-"));
  const state = join(dir, "n");
  writeFileSync(state, "0");
  const bin = join(dir, "wrangler");
  writeFileSync(bin, `#!/bin/sh\nn=$(cat ${state}); echo $((n+1)) > ${state}\ncase $n in\n${outputs.map((o, i) => `${i}) printf '%s\\n' ${JSON.stringify(o)};;`).join("\n")}\n*) printf '%s\\n' ${JSON.stringify(outputs.at(-1))};;\nesac\nexit ${code}\n`);
  chmodSync(bin, 0o755);
  return bin;
}
const run = (bin, extra = {}) => spawnSync(process.execPath, [join(ROOT, "tools/wait_migrations.mjs"), "x.jsonc"], { encoding: "utf8", env: { ...process.env, WRANGLER_BIN: bin, WAIT_MIGRATIONS_POLL_SECONDS: "0.05", ...extra } });

test("no pending migrations: deploy proceeds", () => {
  const r = run(fake(["✅ No migrations to apply!"]));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /schema is current/);
});

test("waits while migrations are pending, then proceeds once applied", () => {
  const r = run(fake(["│ 0003_new.sql │", "│ 0003_new.sql │", "✅ No migrations to apply!"]));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /pending 0003_new\.sql/);
});

test("fails the deploy if migrations stay pending past the limit", () => {
  const r = run(fake(["│ 0003_new.sql │"]), { WAIT_MIGRATIONS_SECONDS: "0.2" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /still pending/);
});

test("can't read the database: warns and lets the deploy continue", () => {
  const r = run(fake(["✘ [ERROR] Authentication error"], 1));
  assert.equal(r.status, 0);
  assert.match(r.stderr, /couldn't read migration status/);
});
