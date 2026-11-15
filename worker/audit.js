// The audit history (owner only): every row of the change log, for all trees and the sharing settings, grouped by the
// batch that wrote it. The list carries summaries; the full before/after of each record comes with one batch's detail.
//
//   GET /api/admin/audit?before=<row id>&limit=&actor=&type=&q=   batches, newest first, and the next page's cursor
//   GET /api/admin/audit/<key>                                    one batch in full (key = batch id, or c<row id>)
import { can } from "./auth.js";
import { fail, json } from "./http.js";
import { parse } from "./db.js";
import { fullBundle } from "./bundle.js";
import { S } from "../strings/index.ts";

const owner = (c) => { if (!can.admin(c.access)) fail(403, S.api.auth.ownerOnly); };
const keyOf = (r) => r.batch_id || `c${r.id}`;
// a short label for a record from its own snapshot (the record may since have been deleted)
const LABEL = `CASE entity_type
  WHEN 'person' THEN trim(coalesce(json_extract(coalesce(after, before), '$.names[0].given'), '') || ' ' || coalesce(json_extract(coalesce(after, before), '$.names[0].surname'), ''))
  WHEN 'todo' THEN json_extract(coalesce(after, before), '$.task')
  WHEN 'story' THEN json_extract(coalesce(after, before), '$.title')
  WHEN 'finding' THEN json_extract(coalesce(after, before), '$.note')
  WHEN 'research_site' THEN json_extract(coalesce(after, before), '$.name')
  ELSE NULL END`;
const SUMMARY_COLS = `id, at, actor, actor_kind, entity_type, entity_id, op, reason, proposal_id, batch_id, on_behalf_of, via,
  CASE WHEN before IS NULL THEN 'created' WHEN after IS NULL THEN 'deleted' ELSE 'updated' END AS change, ${LABEL} AS label`;

function filters(sp) {
  const where = [], args = [];
  const actor = sp.get("actor"), type = sp.get("type"), q = (sp.get("q") || "").trim();
  if (actor) { where.push("(actor = ? OR on_behalf_of = ?)"); args.push(actor, actor); }
  if (type) { where.push("entity_type = ?"); args.push(type); }
  if (q) { where.push("(reason LIKE ? OR entity_id LIKE ? OR batch_id = ?)"); args.push(`%${q}%`, `%${q}%`, q); }
  return { where, args };
}

export async function listAudit(c) {
  owner(c);
  const sp = c.url.searchParams, DB = c.env.DB;
  const limit = Math.max(1, Math.min(100, parseInt(sp.get("limit"), 10) || 40));
  const { where, args } = filters(sp);
  const before = parseInt(sp.get("before"), 10);
  if (before) { where.push("id < ?"); args.push(before); }
  const W = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // one page of batches (a batch spans many rows), then their rows
  const keys = (await DB.prepare(`SELECT COALESCE(batch_id, 'c' || id) AS k, MAX(id) AS last, MIN(id) AS first FROM changes ${W} GROUP BY k ORDER BY last DESC LIMIT ?`).bind(...args, limit).all()).results;
  let rows = [];
  if (keys.length) {
    const batches = keys.filter((k) => !/^c\d+$/.test(k.k)).map((k) => k.k);
    const singles = keys.filter((k) => /^c\d+$/.test(k.k)).map((k) => +k.k.slice(1));
    const parts = [], pargs = [];
    if (batches.length) { parts.push(`batch_id IN (${batches.map(() => "?").join(",")})`); pargs.push(...batches); }
    if (singles.length) { parts.push(`id IN (${singles.map(() => "?").join(",")})`); pargs.push(...singles); }
    rows = (await DB.prepare(`SELECT ${SUMMARY_COLS} FROM changes WHERE ${parts.join(" OR ")} ORDER BY id`).bind(...pargs).all()).results;
  }
  const { full } = await fullBundle(c.env).catch(() => ({ full: { people: {} } }));
  const name = (r) => r.label || (r.entity_type === "person" && full.people[r.entity_id] && full.people[r.entity_id].name) || null;
  const groups = new Map(keys.map((k) => [k.k, null]));
  for (const r of rows) {
    const k = keyOf(r);
    let g = groups.get(k);
    if (!g) {
      g = { key: k, batch: r.batch_id || null, at: r.at, actor: r.actor, actor_kind: r.actor_kind, on_behalf_of: r.on_behalf_of || null, via: r.via || null,
        op: r.op, reason: r.reason || null, proposal: r.proposal_id || null, count: 0, types: {}, entities: [] };
      groups.set(k, g);
    }
    if (["edit", "revert", "import", "storage-upgrade"].includes(r.op)) g.op = r.op; // the batch's main act
    if (!g.reason && r.reason) g.reason = r.reason;
    g.count++;
    g.types[r.entity_type] = (g.types[r.entity_type] || 0) + 1;
    if (g.entities.length < 12) g.entities.push({ type: r.entity_type, id: r.entity_id, change: r.change, op: r.op, label: name(r) });
  }
  const list = [...groups.values()].filter(Boolean);
  const last = keys.length ? Math.min(...keys.map((k) => k.first)) : null;
  // the filter choices, from the whole log
  const actors = sp.get("before") ? undefined : (await DB.prepare("SELECT actor AS v, COUNT(*) AS n FROM changes GROUP BY actor ORDER BY n DESC LIMIT 60").all()).results;
  const types = sp.get("before") ? undefined : (await DB.prepare("SELECT entity_type AS v, COUNT(*) AS n FROM changes GROUP BY entity_type ORDER BY n DESC").all()).results;
  return json({ batches: list, next: keys.length === limit ? last : null, actors, types }, 200, { "Cache-Control": "private, no-store" });
}

export async function auditDetail(c, key) {
  owner(c);
  const DB = c.env.DB;
  const m = /^c(\d+)$/.exec(key);
  const rows = (await (m ? DB.prepare("SELECT * FROM changes WHERE id = ?").bind(+m[1]) : DB.prepare("SELECT * FROM changes WHERE batch_id = ? ORDER BY id").bind(key)).all()).results;
  if (!rows.length) fail(404, S.api.history.noSuchChange);
  const proposalIds = [...new Set(rows.map((r) => r.proposal_id).filter(Boolean))];
  const proposals = proposalIds.length ? (await DB.prepare(`SELECT id, kind, author, author_kind, status, rationale, created_at, reviewed_by, reviewed_at FROM proposals WHERE id IN (${proposalIds.map(() => "?").join(",")})`).bind(...proposalIds).all()).results : [];
  const runIds = [...new Set(rows.map((r) => r.via).filter((v) => /^run-/.test(v || "")))];
  const runs = runIds.length ? (await DB.prepare(`SELECT id, kind, started_by, instructions, status, created_at FROM agent_runs WHERE id IN (${runIds.map(() => "?").join(",")})`).bind(...runIds).all().catch(() => ({ results: [] }))).results : [];
  return json({
    key, batch: rows[0].batch_id || null,
    rows: rows.map((r) => ({ id: r.id, at: r.at, actor: r.actor, actor_kind: r.actor_kind, on_behalf_of: r.on_behalf_of || null, via: r.via || null,
      type: r.entity_type, entity: r.entity_id, op: r.op, reason: r.reason, proposal: r.proposal_id, version_after: r.version_after,
      change: r.before == null ? "created" : r.after == null ? "deleted" : "updated", before: parse(r.before), after: parse(r.after), sources: parse(r.sources, undefined) })),
    proposals, runs,
  }, 200, { "Cache-Control": "private, no-store" });
}
