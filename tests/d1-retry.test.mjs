// D1's brief refusals are retried (worker/d1-retry.js): reads on any temporary error, writes only when D1 turned the
// request away before running it, deterministic errors never; and the site keeps working through a short outage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEnv, migrate } from "./helpers/fake-env.mjs";
import { resilient, withResilientDB, isRead, retryable, withRetry } from "../worker/d1-retry.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOAD = "D1_ERROR: Your account is generating too much load on D1 DBs. Please back off and try again later.";
const INTERNAL = "D1_ERROR: internal error; reference = abc123";
const fast = { delays: [1, 1, 1] };

/** A D1 stand-in whose calls fail with `msg` for the first `n` attempts, then succeed. */
function flaky(n, msg) {
  let left = n;
  const calls = { count: 0 };
  const attempt = (value) => { calls.count++; if (left > 0) { left--; return Promise.reject(new Error(msg)); } return Promise.resolve(value); };
  const stmt = (sql) => ({ sql, bind: () => stmt(sql), first: () => attempt({ ok: 1 }), all: () => attempt({ results: [] }), run: () => attempt({ meta: {} }) });
  return { db: { prepare: stmt, batch: (s) => attempt(s.map(() => ({}))) }, calls };
}

test("which statements count as reads", () => {
  assert.equal(isRead("SELECT * FROM people"), true);
  assert.equal(isRead("  with x as (select 1) select * from x"), true);
  assert.equal(isRead("WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x"), false);
  assert.equal(isRead("INSERT INTO t VALUES (1)"), false);
  assert.equal(isRead("UPDATE people SET data = ?"), false);
});

test("which errors are retried", () => {
  assert.equal(retryable(new Error(LOAD), false), true);
  assert.equal(retryable(new Error("D1 DB is overloaded. Too many requests queued."), false), true);
  assert.equal(retryable(new Error(INTERNAL), true), true);
  assert.equal(retryable(new Error(INTERNAL), false), false); // a write may already have happened
  assert.equal(retryable(new Error("NOT NULL constraint failed: _guard.x"), true), false);
  assert.equal(retryable(new Error("no such table: nope"), true), false);
});

test("reads ride out a burst of refusals and internal errors", async () => {
  for (const msg of [LOAD, INTERNAL]) {
    const { db, calls } = flaky(2, msg);
    assert.deepEqual(await resilient(db, fast).prepare("SELECT 1").bind().first(), { ok: 1 });
    assert.equal(calls.count, 3);
  }
});

test("writes are retried only when D1 turned them away", async () => {
  const a = flaky(1, LOAD);
  await resilient(a.db, fast).prepare("INSERT INTO t VALUES (1)").run();
  assert.equal(a.calls.count, 2);
  const b = flaky(1, INTERNAL);
  await assert.rejects(resilient(b.db, fast).prepare("UPDATE t SET x = 1").run(), /internal error/);
  assert.equal(b.calls.count, 1);
});

test("a batch is retried whole: on any temporary error if it only reads, on refusals otherwise", async () => {
  const r = flaky(1, INTERNAL), rw = resilient(r.db, fast);
  await rw.batch([rw.prepare("SELECT 1"), rw.prepare("SELECT 2")]);
  assert.equal(r.calls.count, 2);
  const w = flaky(1, INTERNAL), ww = resilient(w.db, fast);
  await assert.rejects(ww.batch([ww.prepare("SELECT 1"), ww.prepare("INSERT INTO t VALUES (1)")]));
  assert.equal(w.calls.count, 1);
  const l = flaky(1, LOAD), lw = resilient(l.db, fast);
  await lw.batch([lw.prepare("INSERT INTO t VALUES (1)")]);
  assert.equal(l.calls.count, 2);
});

test("it gives up after a few tries and passes the error on", async () => {
  const { db, calls } = flaky(10, LOAD);
  await assert.rejects(resilient(db, fast).prepare("SELECT 1").all(), /too much load/);
  assert.equal(calls.count, 4);
  await assert.rejects(withRetry(() => Promise.reject(new Error(LOAD)), { delays: [] }), /too much load/);
});

test("one wrapper per binding, so caches keyed by env.DB keep working", () => {
  const env = makeEnv();
  assert.equal(withResilientDB(env).DB, withResilientDB(env).DB);
  assert.equal(withResilientDB(withResilientDB(env)).DB, withResilientDB(env).DB);
});

test("the site answers through a short D1 outage", async () => {
  const env = makeEnv();
  migrate(env.DB, ROOT);
  const worker = (await import("../worker/index.js")).default;
  // the first two queries are refused, as in the outage
  const real = env.DB;
  let refuse = 2;
  const flakyDB = {
    prepare: (sql) => {
      const wrap = (s) => ({ sql, bind: (...a) => wrap(s.bind(...a)), _exec: () => s._exec(),
        first: (...a) => (refuse-- > 0 ? Promise.reject(new Error(LOAD)) : s.first(...a)),
        all: (...a) => (refuse-- > 0 ? Promise.reject(new Error(LOAD)) : s.all(...a)),
        run: (...a) => (refuse-- > 0 ? Promise.reject(new Error(LOAD)) : s.run(...a)) });
      return wrap(real.prepare(sql));
    },
    batch: (stmts) => real.batch(stmts),
  };
  const res = await worker.fetch(new Request("https://tree.example.test/api/me", { headers: { "X-Dev-Principal": "owner@example.test" } }), { ...env, DB: flakyDB }, { waitUntil() {} });
  assert.equal(res.status, 200, await res.text());
  assert.ok(refuse < 0);
});
