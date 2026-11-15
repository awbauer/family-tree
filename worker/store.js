// Persisting edits: load the raw tree with row versions, apply ops (worker/ops.js), and write the touched
// entities back in one D1 batch guarded by versions, with an audit row per entity sharing a batch id.
// Reverting a batch restores the "before" snapshots if nothing has changed those entities since.

import { applyOps } from "./ops.js";
import { J, now, parse, bumpVersion } from "./db.js";
import { readTree, writeRecord, restoreRecord, mode as storageMode } from "./storage.js";
import { S as Strings } from "../strings/index.ts";

const M = Strings.api.ops;

export async function loadEditable(env) {
  const tree = await readTree(env);
  const cfg = (await env.DB.prepare("SELECT key, value, version FROM config WHERE key IN ('media_map', 'aliases')").all()).results;
  const versions = { ...tree.versions };
  const c = Object.fromEntries(cfg.map((r) => { versions[`config:${r.key}`] = r.version; return [r.key, parse(r.value, {})]; }));
  return {
    state: { people: tree.people, families: tree.families, sources: tree.sources, media_map: c.media_map || {}, aliases: c.aliases || {} },
    versions, mode: tree.mode,
  };
}

const guard = (env, sql, ...args) => env.DB.prepare(`INSERT INTO _guard (x) SELECT NULL WHERE ${sql}`).bind(...args);

/** Statements that write `touched` (from applyOps) with version guards and audit rows. */
export function commitStatements(env, { touched, versions, state, actor, actorKind, reason, sources, proposalId, batchId, op = "edit", mode = "working", onBehalfOf = null, via = null }) {
  const t = now();
  const st = [];
  // the evidence cited for this change (prov:used), kept with every row of the batch
  const src = Array.isArray(sources) && sources.length ? J(sources.filter((x) => x && (x.title || x.url || x.note)).slice(0, 50)) : null;
  let mediaTouched = false, aliasesTouched = false;
  for (const x of touched) {
    if (x.type === "media_map") { mediaTouched = true; continue; }
    if (x.type === "aliases") { aliasesTouched = true; continue; }
    const w = writeRecord(env, mode, x, versions, t, actor);
    st.push(...w.statements);
    const vAfter = w.versionAfter;
    st.push(env.DB.prepare("INSERT INTO changes (at, actor, actor_kind, entity_type, entity_id, op, before, after, reason, proposal_id, batch_id, version_after, sources, on_behalf_of, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(t, actor, actorKind, x.type, x.id, op, x.before == null ? null : J(x.before), x.after == null ? null : J(x.after), reason || null, proposalId || null, batchId, vAfter, src, onBehalfOf, via));
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
    st.push(env.DB.prepare("INSERT INTO changes (at, actor, actor_kind, entity_type, entity_id, op, before, after, reason, proposal_id, batch_id, version_after, sources, on_behalf_of, via) VALUES (?, ?, ?, 'config', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(t, actor, actorKind, key, op, J(Object.fromEntries(before.map((b) => [b.id, b.before ?? null]))), J(Object.fromEntries(before.map((b) => [b.id, b.after ?? null]))), reason || null, proposalId || null, batchId, v == null ? 1 : v + 1, src, onBehalfOf, via));
  }
  st.push(bumpVersion(env));
  return st;
}

export const newBatchId = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** Apply ops and write them. Throws OpError for bad ops, or a D1 error (guard) on a version conflict. */
export async function applyAndCommit(env, ops, meta) {
  const { state, versions, mode } = await loadEditable(env);
  const res = applyOps(state, ops, { actor: meta.actor, knower: meta.onBehalfOf || meta.actor });
  if (!res.touched.length) return { batchId: null, touched: [], created: res.created };
  const batchId = meta.batchId || newBatchId();
  const st = commitStatements(env, { ...meta, touched: res.touched, versions, state: res.state, batchId, mode });
  if (meta.extra) st.push(...meta.extra);
  const settled = await settledFindings(env, ops, { ...meta, batchId });
  st.push(...settled.statements);
  await env.DB.batch(st);
  return { batchId, touched: res.touched.map((x) => ({ type: x.type, id: x.id, op: x.before == null ? "created" : x.after == null ? "deleted" : "updated" })), created: res.created, settled: settled.ids };
}

const wordRx = (id) => new RegExp(`(?<![\\w-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);
const FAMILY_ID = /(?<![\w-])(?:[A-Za-z]+-)?F\d+(?![\w-])/g;

/**
 * Open findings this batch does exactly what they ask, closed in the same batch (so undoing the edit reopens them).
 * Deliberately narrow: a sex fix ("Set sex to M") on the finding's own person; a merge of two people the finding
 * names; deleting families when every family the finding names is deleted here and it says to delete or remove them.
 */
export async function settledFindings(env, ops, { actor, actorKind, batchId, onBehalfOf = null, via = null }) {
  const sexFix = new Map(), merges = [], deleted = new Set();
  for (const o of ops || []) {
    if (o.op === "person.update" && o.set && o.set.sex) sexFix.set(o.id, o.set.sex);
    if (o.op === "person.merge" && o.keep && o.drop) merges.push([o.keep, o.drop]);
    if (o.op === "family.delete" && o.family) deleted.add(o.family);
  }
  if (!sexFix.size && !merges.length && !deleted.size) return { statements: [], ids: [] };
  const rows = (await env.DB.prepare("SELECT id, data FROM findings").all()).results;
  const t = now(), statements = [], ids = [];
  for (const r of rows) {
    const d = parse(r.data, {});
    if (d.resolution && d.resolution.status && d.resolution.status !== "open") continue;
    const text = `${d.claim || ""} ${d.finding || ""}`;
    let why = null;
    const m = /set sex to (M|F)\b/i.exec(text);
    if (d.field === "sex" && sexFix.has(d.person) && m && m[1].toUpperCase() === sexFix.get(d.person)) why = M.settledBy.sex;
    if (!why && merges.some(([k, x]) => wordRx(k).test(text) && wordRx(x).test(text))) why = M.settledBy.merge;
    const fams = text.match(FAMILY_ID) || [];
    if (!why && deleted.size && fams.length && fams.every((f) => deleted.has(f)) && /\b(delete|remove)\b/i.test(text)) why = M.settledBy.familyDelete;
    if (!why) continue;
    const resolution = { status: "resolved", by: actor, at: t, note: M.settledNote(why), batch: batchId };
    const open = "COALESCE(json_extract(data, '$.resolution.status'), 'open') = 'open'";
    statements.push(env.DB.prepare(`INSERT INTO changes (at, actor, actor_kind, entity_type, entity_id, op, before, after, reason, batch_id, on_behalf_of, via) SELECT ?, ?, ?, 'finding', ?, 'resolve', json_extract(data, '$.resolution'), ?, ?, ?, ?, ? FROM findings WHERE id = ? AND ${open}`)
      .bind(t, actor, actorKind || "person", String(r.id), J(resolution), resolution.note, batchId, onBehalfOf, via, r.id));
    statements.push(env.DB.prepare(`UPDATE findings SET data = json_set(data, '$.resolution', json(?)), version = version + 1 WHERE id = ? AND ${open}`).bind(J(resolution), r.id));
    ids.push(r.id);
  }
  return { statements, ids };
}

export const isConflict = (e) => /NOT NULL constraint failed: _guard/i.test(String(e && (e.message || e)));

/** Revert a batch: restore every entity's "before", only if each is still at the version that batch left it. */
export async function revertBatch(env, batchId, { actor, actorKind, reason }) {
  const rows = (await env.DB.prepare("SELECT * FROM changes WHERE batch_id = ? ORDER BY id").bind(batchId).all()).results;
  if (!rows.length) return null;
  const t = now(), nb = newBatchId(), st = [];
  const mode = await storageMode(env);
  for (const r of rows) {
    const before = parse(r.before), after = parse(r.after);
    if (r.entity_type === "config") {
      // media_map / aliases: restore the per-person entries this batch changed
      const cur = await env.DB.prepare("SELECT value, version FROM config WHERE key = ?").bind(r.entity_id).first();
      const val = cur ? parse(cur.value, {}) : {};
      // aliases rows hold the whole map before and after under "*"; restore only the entries this batch changed
      const whole = r.entity_id === "aliases" && before && "*" in before;
      const bm = whole ? before["*"] || {} : before || {}, am = whole ? (after || {})["*"] || {} : after || {};
      const keys = whole ? [...new Set([...Object.keys(bm), ...Object.keys(am)])].filter((k) => JSON.stringify(bm[k] ?? null) !== JSON.stringify(am[k] ?? null)) : Object.keys(bm);
      for (const k of keys) {
        if (JSON.stringify(val[k] ?? null) !== JSON.stringify(am[k] ?? null)) throw Object.assign(new Error("changed since"), { conflict: true });
        if (bm[k] == null) delete val[k]; else val[k] = bm[k];
      }
      st.push(guard(env, "NOT EXISTS (SELECT 1 FROM config WHERE key = ? AND version = ?)", r.entity_id, cur ? cur.version : -1));
      st.push(env.DB.prepare("UPDATE config SET value = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE key = ?").bind(J(val), t, actor, r.entity_id));
      st.push(env.DB.prepare("INSERT INTO changes (at, actor, actor_kind, entity_type, entity_id, op, before, after, reason, batch_id, version_after) VALUES (?, ?, ?, 'config', ?, 'revert', ?, ?, ?, ?, ?)")
        .bind(t, actor, actorKind, r.entity_id, r.after, r.before, reason || `revert ${batchId}`, nb, (cur ? cur.version : 0) + 1));
      continue;
    }
    if (r.entity_type === "finding") {
      // a finding resolved by this batch's edit is reopened (or restored to its earlier resolution) by undoing it
      const cur = await env.DB.prepare("SELECT data FROM findings WHERE id = ?").bind(+r.entity_id).first();
      if (!cur) continue;
      const data = parse(cur.data, {});
      if (JSON.stringify(data.resolution ?? null) !== JSON.stringify(after ?? null)) continue; // decided again since: leave it
      if (before == null) delete data.resolution; else data.resolution = before;
      st.push(env.DB.prepare("UPDATE findings SET data = ?, version = version + 1 WHERE id = ?").bind(J(data), +r.entity_id));
      st.push(env.DB.prepare("INSERT INTO changes (at, actor, actor_kind, entity_type, entity_id, op, before, after, reason, batch_id) VALUES (?, ?, ?, 'finding', ?, 'revert', ?, ?, ?, ?)")
        .bind(t, actor, actorKind, r.entity_id, r.after, r.before, reason || `revert ${batchId}`, nb));
      continue;
    }
    if (!["person", "family", "source"].includes(r.entity_type)) continue;
    // allowed only if the record still holds exactly what this batch wrote (content, not version: undoing a later
    // change restores this batch's result, after which this batch can be undone too)
    st.push(...await restoreRecord(env, mode, r.entity_type, r.entity_id, before, after, t, actor));
    st.push(env.DB.prepare("INSERT INTO changes (at, actor, actor_kind, entity_type, entity_id, op, before, after, reason, batch_id, version_after) VALUES (?, ?, ?, ?, ?, 'revert', ?, ?, ?, ?, ?)")
      .bind(t, actor, actorKind, r.entity_type, r.entity_id, r.after, r.before, reason || `revert ${batchId}`, nb, before == null ? null : (after == null ? 1 : r.version_after + 1)));
  }
  st.push(bumpVersion(env));
  await env.DB.batch(st);
  return { batchId: nb, reverted: batchId, entities: rows.length };
}
