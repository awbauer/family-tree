// Riding out D1's brief platform hiccups. D1 sometimes refuses queries for a minute ("Your account is generating
// too much load on D1 DBs", "D1 DB is overloaded", internal error 7500 "a platform-side storage event made the
// database temporarily unavailable"), and its documented fix is to retry with backoff. Without that, one refused
// query in /api/me takes the whole site down.
//
// resilient(db) wraps a D1 binding so every query retries those errors a few times (about 1.5 s in all) before
// failing. Reads retry on any of them. Writes retry only on errors that mean the request was turned away before it
// ran (load and queue limits), never on an internal error, where a write may already have happened. Deterministic
// errors (a constraint, the _guard version check, bad SQL) are never retried.
//
// The wrapper is one object per binding (memoized), so code that caches by `env.DB` identity keeps working.

/** Errors that mean D1 didn't run the request: safe to retry, reads and writes alike. */
const TURNED_AWAY = /too much load|overloaded|too many requests queued|queued for too long|too many resources consumed/i;
/** Errors that may be transient but where a write could already have happened: retry reads only. */
const MAYBE_RAN = /internal error|network connection lost|reset because|storage operation exceeded timeout|starting up d1 db storage|7500/i;
const READ = /^\s*(select|with|pragma|explain)\b/i;
const WRITE_IN_WITH = /\b(insert|update|delete|replace)\b/i;

export const isRead = (sql) => READ.test(String(sql || "")) && !(/^\s*with\b/i.test(sql) && WRITE_IN_WITH.test(sql));

export function retryable(err, read) {
  const m = String((err && (err.message || err.cause && err.cause.message)) || err || "");
  return TURNED_AWAY.test(m) || (read && MAYBE_RAN.test(m));
}

const DELAYS = [100, 350, 1000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run `fn`, retrying D1's temporary refusals with jittered backoff. */
export async function withRetry(fn, { read = false, delays = DELAYS, onRetry } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (attempt >= delays.length || !retryable(e, read)) throw e;
      if (onRetry) onRetry(e, attempt + 1);
      await sleep(delays[attempt] * (0.75 + Math.random() * 0.5));
    }
  }
}

const log = (e, n) => console.warn(`d1 retry ${n}: ${String(e && e.message || e).slice(0, 160)}`);

class Statement {
  constructor(inner, sql, opts) { this.inner = inner; this.sql = sql; this.opts = opts; }
  bind(...args) { return new Statement(this.inner.bind(...args), this.sql, this.opts); }
  #run(method, args) { return withRetry(() => this.inner[method](...args), { ...this.opts, read: isRead(this.sql), onRetry: log }); }
  first(...a) { return this.#run("first", a); }
  all(...a) { return this.#run("all", a); }
  run(...a) { return this.#run("run", a); }
  raw(...a) { return this.#run("raw", a); }
}

const wrapped = new WeakMap();

/** The D1 binding with retries (the same wrapper every time for the same binding). */
export function resilient(db, opts = {}) {
  if (!db || typeof db.prepare !== "function" || db.__resilient) return db;
  if (wrapped.has(db)) return wrapped.get(db);
  const unwrap = (s) => (s instanceof Statement ? s.inner : s);
  const w = {
    __resilient: true,
    prepare: (sql) => new Statement(db.prepare(sql), sql, opts),
    // a batch is one transaction: retry it whole, on any error only when every statement reads
    batch: (stmts) => withRetry(() => db.batch(stmts.map(unwrap)), { ...opts, read: stmts.every((s) => isRead(s instanceof Statement ? s.sql : s && s.sql)), onRetry: log }),
    exec: (...a) => db.exec(...a),
    dump: (...a) => db.dump(...a),
    withSession: (...a) => db.withSession(...a),
  };
  wrapped.set(db, w);
  return w;
}

/** env with its D1 binding made resilient (the same env object shape; other bindings untouched). */
export const withResilientDB = (env) => (env && env.DB && !env.DB.__resilient ? { ...env, DB: resilient(env.DB) } : env);
