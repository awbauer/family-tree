// Persisting edits: load the raw tree with row versions, apply ops (worker/ops.js), and write the touched
// entities back in one D1 batch guarded by versions, with an audit row per entity sharing a batch id.
// Reverting a batch restores the "before" snapshots if nothing has changed those entities since.

import { applyOps } from "./ops.js";
import { J, now, parse, bumpVersion } from "./db.js";

const TABLE = { person: "people", family: "families", source: "sources" };

export async function loadEditable(env) {
  const q = (sql) => env.DB.prepare(sql).all().then((r) => r.results);
  const [people, families, sources, cfg] = await Promise.all([
    q("SELECT id, data, version FROM people"), q("SELECT id, data, version FROM families"), q("SELECT id, data, version FROM sources"),
    q("SELECT key, value, version FROM config WHERE key IN ('media_map', 'aliases')"),
  ]);
  const versions = {};
  const by = (rows, t) => Object.fromEntries(rows.map((r) => { versions[`${t}:${r.id}`] = r.version; return [r.id, parse(r.data)]; }));
  const c = Object.fromEntries(cfg.map((r) => { versions[`config:${r.key}`] = r.version; return [r.key, parse(r.value, {})]; }));
  return {
    state: { people: by(people, "person"), families: by(families, "family"), sources: by(sources, "source"), media_map: c.media_map || {}, aliases: c.aliases || {} },
    versions,
  };
}

const guard = (env, sql, ...args) => env.DB.prepare(`INSERT INTO _guard (x) SELECT NULL WHERE ${sql}`).bind(...args);

/** Statements that write `touched` (from applyOps) with version guards and audit rows. */
export function commitStatements(env, { touched, versions, state, actor, actorKind, reason, sources, proposalId, batchId, op = "edit" }) {
  const t = now();
  const st = [];
  let mediaTouched = false, aliasesTouched = false;
  for (const x of touched) {
    if (x.type === "media_map") { mediaTouched = true; continue; }
    if (x.type === "aliases") { aliasesTouched = true; continue; }
    const tbl = TABLE[x.type];
    const v = versions[`${x.type}:${x.id}`];
    if (x.before === undefined || x.before === null) {
      st.push(guard(env, `EXISTS (SELECT 1 FROM ${tbl} WHERE id = ?)`, x.id));
      st.push(env.DB.prepare(`INSERT INTO ${tbl} (id, data, version, updated_at, updated_by) VALUES (?, ?, 1, ?, ?)`).bind(x.id, J(x.after), t, actor));
    } else {
      st.push(guard(env, `NOT EXISTS (SELECT 1 FROM ${tbl} WHERE id = ? AND version = ?)`, x.id, v));
      if (x.after === undefined || x.after === null) st.push(env.DB.prepare(`DELETE FROM ${tbl} WHERE id = ?`).bind(x.id));
      else st.push(env.DB.prepare(`UPDATE ${tbl} SET data = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?`).bind(J(x.after), t, actor, x.id));
    }
    const vAfter = x.after == null ? null : (x.before == null ? 1 : v + 1);
    st.push(env.DB.prepare("INSERT INTO changes (at, actor, actor_kind, entity_type, entity_id, op, before, after, reason, proposal_id, batch_id, version_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(t, actor, actorKind, x.type, x.id, op, x.before == null ? null : J(x.before), x.after == null ? null : J(x.after), reason || null, proposalId || null, batchId, vAfter));
  }
  // A merge (person.merge) adds an alias drop -> keep. Re-point the research rows filed under the dropped person in the
  // same batch, so findings, to-dos, log entries, statuses and comments follow them to the surviving record.
  if (aliasesTouched) {
    const al = touched.find((x) => x.type === "aliases");
    for (const [drop, keep] of Object.entries(al.after || {})) {
      if ((al.before || {})[drop] === keep) continue;
      st.push(env.DB.prepare("UPDATE findings SET person_id = ?, data = json_set(data, '$.person', ?) WHERE person_id = ?").bind(keep, keep, drop));
      st.push(env.DB.prepare("UPDATE todos SET person_id = ?, updated_at = ?, updated_by = ? WHERE person_id = ?").bind(keep, t, actor, drop));
      st.push(env.DB.prepare("UPDATE research_log SET person_id = ?, data = json_set(data, '$.person', ?) WHERE person_id = ?").bind(keep, keep, drop));
      st.push(env.DB.prepare("UPDATE comments SET entity_id = ? WHERE entity_type = 'person' AND entity_id = ?").bind(keep, drop));
      // keep the surviving person's own status if it has one; otherwise take the dropped person's
      st.push(env.DB.prepare("INSERT OR IGNORE INTO statuses (person_id, data, updated_at, updated_by) SELECT ?, data, ?, ? FROM statuses WHERE person_id = ?").bind(keep, t, actor, drop));
      st.push(env.DB.prepare("DELETE FROM statuses WHERE person_id = ?").bind(drop));
    }
  }
  for (const [key, flag, value] of [["media_map", mediaTouched, state.media_map], ["aliases", aliasesTouched, state.aliases]]) {
    if (!flag) continue;
    const v = versions[`config:${key}`];
    const before = touched.filter((x) => x.type === key || (key === "aliases" && x.type === "aliases"));
    if (v == null) {
      st.push(env.DB.prepare("INSERT INTO config (key, value, version, updated_at, updated_by) VALUES (?, ?, 1, ?, ?)").bind(key, J(value), t, actor));
    } else {
      st.push(guard(env, "NOT EXISTS (SELECT 1 FROM config WHERE key = ? AND version = ?)", key, v));
      st.push(env.DB.prepare("UPDATE config SET value = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE key = ?").bind(J(value), t, actor, key));
    }
    st.push(env.DB.prepare("INSERT INTO changes (at, actor, actor_kind, entity_type, entity_id, op, before, after, reason, proposal_id, batch_id, version_after) VALUES (?, ?, ?, 'config', ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(t, actor, actorKind, key, op, J(Object.fromEntries(before.map((b) => [b.id, b.before ?? null]))), J(Object.fromEntries(before.map((b) => [b.id, b.after ?? null]))), reason || null, proposalId || null, batchId, v == null ? 1 : v + 1));
  }
  st.push(bumpVersion(env));
  return st;
}

export const newBatchId = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** Apply ops and write them. Throws OpError for bad ops, or a D1 error (guard) on a version conflict. */
export async function applyAndCommit(env, ops, meta) {
  const { state, versions } = await loadEditable(env);
  const res = applyOps(state, ops, { actor: meta.actor });
  if (!res.touched.length) return { batchId: null, touched: [], created: res.created };
  const batchId = newBatchId();
  const st = commitStatements(env, { ...meta, touched: res.touched, versions, state: res.state, batchId });
  if (meta.extra) st.push(...meta.extra);
  await env.DB.batch(st);
  return { batchId, touched: res.touched.map((x) => ({ type: x.type, id: x.id, op: x.before == null ? "created" : x.after == null ? "deleted" : "updated" })), created: res.created };
}

export const isConflict = (e) => /NOT NULL constraint failed: _guard/i.test(String(e && (e.message || e)));

/** Revert a batch: restore every entity's "before", only if each is still at the version that batch left it. */
export async function revertBatch(env, batchId, { actor, actorKind, reason }) {
  const rows = (await env.DB.prepare("SELECT * FROM changes WHERE batch_id = ? ORDER BY id").bind(batchId).all()).results;
  if (!rows.length) return null;
  const t = now(), nb = newBatchId(), st = [];
  for (const r of rows) {
    const before = parse(r.before), after = parse(r.after);
    if (r.entity_type === "config") {
      // media_map / aliases: restore the per-person entries this batch changed
      const cur = await env.DB.prepare("SELECT value, version FROM config WHERE key = ?").bind(r.entity_id).first();
      const val = cur ? parse(cur.value, {}) : {};
      for (const [k, b] of Object.entries(before || {})) {
        if (JSON.stringify(val[k] ?? null) !== JSON.stringify((after || {})[k] ?? null)) throw Object.assign(new Error("changed since"), { conflict: true });
        if (r.entity_id === "aliases") Object.assign(val, b || {}); else if (b == null) delete val[k]; else val[k] = b;
        if (r.entity_id === "aliases") for (const a of Object.keys(after || {})) if (!(a in (b || {}))) delete val[a];
      }
      st.push(guard(env, "NOT EXISTS (SELECT 1 FROM config WHERE key = ? AND version = ?)", r.entity_id, cur ? cur.version : -1));
      st.push(env.DB.prepare("UPDATE config SET value = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE key = ?").bind(J(val), t, actor, r.entity_id));
      st.push(env.DB.prepare("INSERT INTO changes (at, actor, actor_kind, entity_type, entity_id, op, before, after, reason, batch_id, version_after) VALUES (?, ?, ?, 'config', ?, 'revert', ?, ?, ?, ?, ?)")
        .bind(t, actor, actorKind, r.entity_id, r.after, r.before, reason || `revert ${batchId}`, nb, (cur ? cur.version : 0) + 1));
      continue;
    }
    const tbl = TABLE[r.entity_type];
    if (!tbl) continue;
    if (after == null) {
      st.push(guard(env, `EXISTS (SELECT 1 FROM ${tbl} WHERE id = ?)`, r.entity_id));
      st.push(env.DB.prepare(`INSERT INTO ${tbl} (id, data, version, updated_at, updated_by) VALUES (?, ?, 1, ?, ?)`).bind(r.entity_id, r.before, t, actor));
    } else {
      // allowed only if the record still holds exactly what this batch wrote (content, not version: undoing a
      // later change restores this batch's result, after which this batch can be undone too)
      st.push(guard(env, `NOT EXISTS (SELECT 1 FROM ${tbl} WHERE id = ? AND data = ?)`, r.entity_id, r.after));
      if (before == null) st.push(env.DB.prepare(`DELETE FROM ${tbl} WHERE id = ?`).bind(r.entity_id));
      else st.push(env.DB.prepare(`UPDATE ${tbl} SET data = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?`).bind(r.before, t, actor, r.entity_id));
    }
    st.push(env.DB.prepare("INSERT INTO changes (at, actor, actor_kind, entity_type, entity_id, op, before, after, reason, batch_id, version_after) VALUES (?, ?, ?, ?, ?, 'revert', ?, ?, ?, ?, ?)")
      .bind(t, actor, actorKind, r.entity_type, r.entity_id, r.after, r.before, reason || `revert ${batchId}`, nb, before == null ? null : (after == null ? 1 : r.version_after + 1)));
  }
  st.push(bumpVersion(env));
  await env.DB.batch(st);
  return { batchId: nb, reverted: batchId, entities: rows.length };
}
