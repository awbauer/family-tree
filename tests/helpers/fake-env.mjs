// A D1 + R2 + Assets stand-in for tests, backed by Node's built-in SQLite (node:sqlite).
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Apply every migrations/*.sql in order. */
export function migrate(db, root) {
  for (const f of readdirSync(join(root, "migrations")).filter((x) => x.endsWith(".sql")).sort()) db.execFile(join(root, "migrations", f));
}

class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.params = []; }
  bind(...p) { const s = new Stmt(this.db, this.sql); s.params = p.map((v) => (v === undefined ? null : v)); return s; }
  _returnsRows() { return /^\s*(select|with|pragma)\b/i.test(this.sql) || /\breturning\b/i.test(this.sql); }
  _exec() {
    const st = this.db.prepare(this.sql);
    if (this._returnsRows()) {
      const rows = st.all(...this.params).map((r) => ({ ...r }));
      return { results: rows, meta: { changes: rows.length } };
    }
    const r = st.run(...this.params);
    return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async all() { return this._exec(); }
  async first(col) { const r = this._exec().results[0] || null; return r && col ? r[col] : r; }
  async run() { return this._exec(); }
}

export class FakeD1 {
  constructor() { this.db = new DatabaseSync(":memory:"); }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) {
    this.db.exec("BEGIN");
    try {
      const out = stmts.map((s) => s._exec());
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  exec(sql) { this.db.exec(sql); }
  execFile(path) { this.db.exec(readFileSync(path, "utf8")); }
}

export class FakeR2 {
  constructor() { this.objects = new Map(); }
  async put(key, value, opts = {}) { this.objects.set(key, { body: value, httpMetadata: opts.httpMetadata || {} }); }
  async get(key) {
    const o = this.objects.get(key);
    if (!o) return null;
    const blob = new Blob([o.body]);
    return { body: o.body, size: blob.size, arrayBuffer: () => blob.arrayBuffer(), httpEtag: `"${key}"`,
      writeHttpMetadata: (h) => o.httpMetadata.contentType && h.set("Content-Type", o.httpMetadata.contentType) };
  }
  async delete(keys) { for (const k of [].concat(keys)) this.objects.delete(k); }
  async list({ prefix = "" } = {}) { return { objects: [...this.objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }; }
}

export function makeEnv(extra = {}) {
  return {
    DB: new FakeD1(), MEDIA: new FakeR2(),
    ASSETS: { fetch: async () => new Response("<!doctype html>static", { headers: { "Content-Type": "text/html" } }) },
    ALLOW_UNAUTHENTICATED: "true", OWNER_EMAIL: "owner@example.test",
    ...extra,
  };
}

/** Call the Worker as `principal`. With FT_STORAGE=gedcomx, the seeded database is first moved to GEDCOM X
 *  storage, so the whole suite also runs against relationships instead of families (npm run test:gedcomx). */
export function client(worker, env) {
  let ready = null;
  const prepare = async () => {
    if (process.env.FT_STORAGE !== "gedcomx") return;
    const { upgrade } = await import("../../worker/storage.js");
    const r = await upgrade(env, { dryRun: false, actor: "test" });
    if (!r.ok) throw new Error(`storage upgrade failed: ${JSON.stringify(r.mismatched)}`);
  };
  return async (method, path, { as = "owner@example.test", body } = {}) => {
    await (ready = ready || prepare());
    const req = new Request(`https://tree.example.test${path}`, {
      method, headers: { "X-Dev-Principal": as, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const res = await worker.fetch(req, env, { waitUntil() {} });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
}
