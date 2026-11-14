// Research batches (findings, research log, statuses, stories, new to-dos, closed to-dos) arrive as proposals and
// are applied when an editor approves them. Validation mirrors tools/merge_research.py so local and web paths agree.

import { J, now, audit } from "./db.js";

export const RANK = { unverified: 0, "partly-verified": 1, verified: 2, disputed: 3 };
const KINDS = new Set(["confirmed", "correction", "conflict", "data-error", "new-fact", "new-person"]);
const LEVELS = new Set(["high", "medium", "low"]);
const RESULTS = new Set(["found", "nil", "inconclusive"]);

/** Returns a list of error strings ([] = valid). `visible(id)` says whether a person is in the author's scope. */
export function validateBatch(b, visible) {
  const errs = [];
  const person = (pid, where, required = true) => {
    if (!pid) { if (required) errs.push(`${where}: missing person`); }
    else if (!visible(pid)) errs.push(`${where}: person ${JSON.stringify(pid)} is not in this tree`);
  };
  const sources = (srcs, where) => {
    if (!srcs || !srcs.length) errs.push(`${where}: no sources. Every claim needs a citation`);
    (srcs || []).forEach((s, j) => {
      if (!String(s.title || "").trim()) errs.push(`${where}.sources[${j}]: missing title`);
      if (!String(s.url || "").trim() && !String(s.note || "").trim()) errs.push(`${where}.sources[${j}]: needs a url or a note saying where the record is`);
    });
  };
  if (!b || typeof b !== "object") return ["batch must be a JSON object"];
  (b.findings || []).forEach((f, i) => {
    const w = `findings[${i}]`;
    person(f.person, w, f.kind !== "new-person");
    if (!KINDS.has(f.kind)) errs.push(`${w}: kind must be one of ${[...KINDS].join(", ")}`);
    if (!LEVELS.has(f.confidence)) errs.push(`${w}: confidence must be high, medium or low`);
    if (!String(f.finding || "").trim()) errs.push(`${w}: empty finding`);
    sources(f.sources, w);
  });
  for (const [pid, st] of Object.entries(b.people_status || {})) {
    person(pid, `people_status[${pid}]`);
    if (!(st && st.status in RANK)) errs.push(`people_status[${pid}]: status must be one of ${Object.keys(RANK).join(", ")}`);
  }
  (b.stories || []).forEach((s, i) => {
    (s.people || []).forEach((p) => person(p, `stories[${i}]`));
    for (const m of String(s.body || "").matchAll(/\[\[([^|\]]+)/g)) person(m[1], `stories[${i}].body link`);
    if (!String(s.title || "").trim()) errs.push(`stories[${i}]: missing title`);
    sources(s.sources, `stories[${i}]`);
  });
  (b.todo || []).forEach((t, i) => {
    person(t.person, `todo[${i}]`, false);
    if (!LEVELS.has(t.priority)) errs.push(`todo[${i}]: priority must be high, medium or low`);
    if (!String(t.task || "").trim()) errs.push(`todo[${i}]: missing task`);
  });
  (b.todo_done || []).forEach((t, i) => { if (!t.id && !t.task) errs.push(`todo_done[${i}]: give the to-do id (or its task text)`); });
  (b.log || []).forEach((l, i) => {
    person(l.person, `log[${i}]`, false);
    if (!RESULTS.has(l.result)) errs.push(`log[${i}]: result must be found, nil or inconclusive`);
    if (!String(l.searched || "").trim()) errs.push(`log[${i}]: say what was searched (collection, site, archive)`);
  });
  if (b.media) errs.push("media: photos are attached by the owner, not through research batches (yet)");
  return errs;
}

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

/** D1 statements that apply an approved research batch. Idempotent like merge_research.py (skips duplicates). */
export async function researchStatements(env, b, { actor, actorKind, proposalId, treeId }) {
  const t = now();
  const st = [];
  const existing = new Set((await env.DB.prepare("SELECT person_id, json_extract(data, '$.finding') AS f FROM findings").all()).results.map((r) => `${r.person_id}|${r.f}`));
  for (const f of b.findings || []) {
    if (existing.has(`${f.person || null}|${f.finding}`)) continue;
    const data = Object.assign({}, f, { branch: f.branch || b.branch || null, date: f.date || t.slice(0, 10), agent: f.agent || b.agent || undefined });
    st.push(env.DB.prepare("INSERT INTO findings (person_id, data, created_at, created_by, proposal_id) VALUES (?, ?, ?, ?, ?)").bind(f.person || null, J(data), t, actor, proposalId));
  }
  for (const [pid, s] of Object.entries(b.people_status || {})) {
    const cur = await env.DB.prepare("SELECT data FROM statuses WHERE person_id = ?").bind(pid).first();
    const c = cur ? JSON.parse(cur.data) : null;
    if (c && RANK[s.status] < RANK[c.status]) continue;
    st.push(env.DB.prepare("INSERT INTO statuses (person_id, data, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(person_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by, version = version + 1").bind(pid, J(s), t, actor));
    st.push(audit(env, { actor, actorKind, entityType: "status", entityId: pid, op: "set", before: c, after: s, proposalId }));
  }
  for (const s of b.stories || []) {
    const slug = s.slug || slugify(s.title);
    st.push(env.DB.prepare("INSERT OR IGNORE INTO stories (slug, data, updated_at, updated_by) VALUES (?, ?, ?, ?)").bind(slug, J(Object.assign({ branch: b.branch || null }, s, { slug })), t, actor));
  }
  const openTodos = (await env.DB.prepare("SELECT id, person_id, task, status FROM todos WHERE status NOT IN ('done','wont_do')").all()).results;
  const seenTasks = new Set(openTodos.map((r) => `${r.person_id}|${r.task}`));
  for (const td of b.todo || []) {
    if (seenTasks.has(`${td.person || null}|${td.task}`)) continue;
    st.push(env.DB.prepare("INSERT INTO todos (person_id, tree_id, task, location, priority, status, branch, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)")
      .bind(td.person || null, td.person ? null : treeId, td.task, td.where || null, td.priority, td.branch || b.branch || null, t, actor, t, actor));
  }
  for (const d of b.todo_done || []) {
    const hits = openTodos.filter((r) => (d.id ? r.id === d.id : (!d.person || r.person_id === d.person) && r.task.startsWith(d.task)));
    if (hits.length !== 1) continue;
    st.push(env.DB.prepare("UPDATE todos SET status = 'done', outcome = ?, closed_at = ?, updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?").bind(d.outcome || "", t, t, actor, hits[0].id));
    st.push(env.DB.prepare("INSERT INTO todo_events (todo_id, at, actor, kind, data) VALUES (?, ?, ?, 'status', ?)").bind(hits[0].id, t, actor, J({ from: hits[0].status, to: "done", outcome: d.outcome || "", proposal: proposalId })));
  }
  const seenLog = new Set((await env.DB.prepare("SELECT person_id, json_extract(data, '$.searched') AS s FROM research_log").all()).results.map((r) => `${r.person_id}|${r.s}`));
  for (const l of b.log || []) {
    if (seenLog.has(`${l.person || null}|${l.searched}`)) continue;
    st.push(env.DB.prepare("INSERT INTO research_log (person_id, data, created_at, created_by, proposal_id) VALUES (?, ?, ?, ?, ?)").bind(l.person || null, J(Object.assign({ date: t.slice(0, 10), agent: b.agent || undefined }, l)), t, actor, proposalId));
  }
  return st;
}
