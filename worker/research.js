// Research batches (findings, research log, statuses, stories, new to-dos, closed to-dos) arrive as proposals and
// are applied when an editor approves them. Validation mirrors tools/merge_research.py so local and web paths agree.

import { J, now, audit, parse, guard } from "./db.js";
import { S } from "../strings/index.ts";

export const RANK = { unverified: 0, "partly-verified": 1, verified: 2, disputed: 3 };
const KINDS = new Set(["confirmed", "correction", "conflict", "data-error", "new-fact", "new-person"]);
const LEVELS = new Set(["high", "medium", "low"]);
export const batchObjects = (value) => Array.isArray(value) && value.every((row) => row && typeof row === "object" && !Array.isArray(row));
const RESULTS = new Set(["found", "nil", "inconclusive"]);

/**
 * Point a batch at the people that merged-away ids became. `aliases` is {dropped: kept} from merges (followed through
 * chains). A suggestion written before a merge would otherwise fail its re-check on approval.
 */
export function followMerges(b, aliases = {}) {
  const to = (id) => { const seen = new Set(); while (aliases[id] && !seen.has(id)) { seen.add(id); id = aliases[id]; } return id; };
  let s = JSON.stringify(b);
  for (const id of Object.keys(aliases || {})) {
    const t = to(id);
    if (t === id || !s.includes(id)) continue;
    s = s.split(JSON.stringify(id)).join(JSON.stringify(t)) // ids as values and keys (people_status), including ops
      .replace(new RegExp(`\\[\\[${id.replace(/[^\w-]/g, "")}(?=[|\\]])`, "g"), `[[${t}`); // story links [[I12|…]]
  }
  return JSON.parse(s);
}

/**
 * Leave out the findings, to-dos, log entries and statuses about people who aren't in the tree any more (removed, not
 * merged). Returns the trimmed batch and which people were left out. Stories aren't trimmed: one that names a missing
 * person still fails the re-check.
 */
export function dropMissing(b, visible) {
  const gone = new Set(), keep = (pid) => !pid || visible(pid) || (gone.add(pid), false);
  const out = { ...b };
  if (b.findings) out.findings = b.findings.filter((f) => keep(f.person));
  if (b.todo) out.todo = b.todo.filter((t) => keep(t.person));
  if (b.log) out.log = b.log.filter((l) => keep(l.person));
  if (b.people_status) out.people_status = Object.fromEntries(Object.entries(b.people_status).filter(([pid]) => keep(pid)));
  const dropped = ["findings", "todo", "log"].reduce((n, k) => n + ((b[k] || []).length - (out[k] || []).length), 0)
    + Object.keys(b.people_status || {}).length - Object.keys(out.people_status || {}).length;
  return { batch: out, missing: [...gone], dropped };
}

/** Returns a list of error strings ([] = valid). `visible(id)` says whether a person is in the author's scope. */
export function validateBatch(b, visible) {
  const errs = [], M = S.api.batch;
  const person = (pid, where, required = true) => {
    if (!pid) { if (required) errs.push(M.missingPerson(where)); }
    else if (!visible(pid)) errs.push(M.personNotInTree(where, pid));
  };
  const sources = (srcs, where) => {
    if (!batchObjects(srcs) || !srcs.length) { errs.push(M.noSources(where)); return; }
    srcs.forEach((s, j) => {
      if (!String(s.title || "").trim()) errs.push(M.sourceTitle(where, j));
      if (!String(s.url || "").trim() && !String(s.note || "").trim()) errs.push(M.sourceWhere(where, j));
    });
  };
  if (!b || typeof b !== "object" || Array.isArray(b)) return [M.notObject];
  for (const key of ["findings", "stories", "story_updates", "todo", "todo_done", "log"]) {
    if (b[key] != null && !batchObjects(b[key])) errs.push(M.objectsRequired(key));
  }
  if (b.people_status != null && (typeof b.people_status !== "object" || Array.isArray(b.people_status))) errs.push(M.notObject);
  if (errs.length) return errs;
  (b.findings || []).forEach((f, i) => {
    const w = `findings[${i}]`;
    person(f.person, w, f.kind !== "new-person");
    if (!KINDS.has(f.kind)) errs.push(M.findingKind(w, [...KINDS]));
    if (!LEVELS.has(f.confidence)) errs.push(M.confidence(w));
    if (!String(f.finding || "").trim()) errs.push(M.emptyFinding(w));
    if (f.fact != null && !/^[en]\d+$/.test(String(f.fact))) errs.push(M.factId(w));
    if (f.proposed_ops != null) {
      if (!Array.isArray(f.proposed_ops) || !f.proposed_ops.length || f.proposed_ops.some((o) => !o || typeof o.op !== "string")) errs.push(M.proposedOps(w));
      else if (f.proposed_ops.some((o) => o.op === "person.delete")) errs.push(M.proposedDelete(w));
    }
    if (f.resolution) errs.push(M.resolutionSet(w));
    sources(f.sources, w);
  });
  for (const [pid, st] of Object.entries(b.people_status || {})) {
    person(pid, `people_status[${pid}]`);
    if (!(st && Object.hasOwn(RANK, st.status))) errs.push(M.peopleStatus(`people_status[${pid}]`, Object.keys(RANK)));
  }
  (b.stories || []).forEach((s, i) => {
    if (s.people != null && !Array.isArray(s.people)) { errs.push(M.peopleArray(`stories[${i}]`)); return; }
    (s.people || []).forEach((p) => person(p, `stories[${i}]`));
    for (const m of String(s.body || "").matchAll(/\[\[([^|\]]+)/g)) person(m[1], `stories[${i}].body link`);
    if (!String(s.title || "").trim()) errs.push(M.missingTitle(`stories[${i}]`));
    sources(s.sources, `stories[${i}]`);
  });
  // revisions of existing stories (the content job proposes these when a story's facts change; web-only for now)
  (b.story_updates || []).forEach((s, i) => {
    const w = `story_updates[${i}]`;
    if (!String(s.slug || "").trim()) errs.push(M.missingSlug(w));
    if (!String(s.body || "").trim()) errs.push(M.emptyBody(w));
    if (s.people != null && !Array.isArray(s.people)) { errs.push(M.peopleArray(w)); return; }
    (s.people || []).forEach((p) => person(p, w));
    for (const m of String(s.body || "").matchAll(/\[\[([^|\]]+)/g)) person(m[1], `${w}.body link`);
    // a revision carries the story's existing citations forward; it must keep some, but they were already accepted
    if (!batchObjects(s.sources) || !s.sources.length) errs.push(M.keepCitations(w));
  });
  (b.todo || []).forEach((t, i) => {
    person(t.person, `todo[${i}]`, false);
    if (!LEVELS.has(t.priority)) errs.push(M.todoPriority(`todo[${i}]`));
    if (!String(t.task || "").trim()) errs.push(M.missingTask(`todo[${i}]`));
  });
  (b.todo_done || []).forEach((t, i) => {
    if (!(Number.isSafeInteger(t.id) && t.id > 0) && !(typeof t.task === "string" && t.task.trim())) errs.push(M.todoDoneId(`todo_done[${i}]`));
    person(t.person, `todo_done[${i}]`, false);
  });
  (b.log || []).forEach((l, i) => {
    person(l.person, `log[${i}]`, false);
    if (!RESULTS.has(l.result)) errs.push(M.logResult(`log[${i}]`));
    if (!String(l.searched || "").trim()) errs.push(M.logSearched(`log[${i}]`));
  });
  if (b.media) errs.push(M.noMedia);
  return errs;
}

export const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

/** D1 statements that apply an approved research batch. Idempotent like merge_research.py (skips duplicates). */
export async function researchStatements(env, b, { actor, actorKind, proposalId, treeId, canReadTodo }) {
  const t = now();
  const st = [];
  const existing = new Set((await env.DB.prepare("SELECT person_id, json_extract(data, '$.finding') AS f FROM findings").all()).results.map((r) => `${r.person_id}|${r.f}`));
  for (const f of b.findings || []) {
    if (existing.has(`${f.person || null}|${f.finding}`)) continue;
    const data = Object.assign({}, f, { branch: f.branch || b.branch || null, date: f.date || t.slice(0, 10), agent: f.agent || b.agent || undefined });
    st.push(env.DB.prepare("INSERT INTO findings (person_id, data, created_at, created_by, proposal_id) VALUES (?, ?, ?, ?, ?)").bind(f.person || null, J(data), t, actor, proposalId));
  }
  for (const [pid, s] of Object.entries(b.people_status || {})) {
    const cur = await env.DB.prepare("SELECT data, version FROM statuses WHERE person_id = ?").bind(pid).first();
    const c = cur ? JSON.parse(cur.data) : null;
    if (c && RANK[s.status] < RANK[c.status]) continue;
    st.push(cur
      ? guard(env, "NOT EXISTS (SELECT 1 FROM statuses WHERE person_id = ? AND version = ?)", pid, cur.version)
      : guard(env, "EXISTS (SELECT 1 FROM statuses WHERE person_id = ?)", pid));
    st.push(env.DB.prepare("INSERT INTO statuses (person_id, data, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(person_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by, version = version + 1").bind(pid, J(s), t, actor));
    st.push(audit(env, { actor, actorKind, entityType: "status", entityId: pid, op: "set", before: c, after: s, proposalId }));
  }
  for (const s of b.stories || []) {
    const slug = s.slug || slugify(s.title);
    st.push(env.DB.prepare("INSERT OR IGNORE INTO stories (slug, data, updated_at, updated_by) VALUES (?, ?, ?, ?)").bind(slug, J(Object.assign({ branch: b.branch || null }, s, { slug })), t, actor));
  }
  for (const s of b.story_updates || []) {
    const cur = await env.DB.prepare("SELECT data, version FROM stories WHERE slug = ?").bind(s.slug).first();
    if (!cur) continue; // the story was removed meanwhile
    st.push(guard(env, "NOT EXISTS (SELECT 1 FROM stories WHERE slug = ? AND version = ?)", s.slug, cur.version));
    const before = parse(cur.data, {});
    const after = Object.assign({}, before, { title: s.title || before.title, body: s.body, people: s.people || before.people, sources: s.sources || before.sources, revised: t.slice(0, 10) });
    st.push(env.DB.prepare("UPDATE stories SET data = ?, updated_at = ?, updated_by = ?, version = version + 1 WHERE slug = ?").bind(J(after), t, actor, s.slug));
    st.push(audit(env, { actor, actorKind, entityType: "story", entityId: s.slug, op: "revise", before, after, reason: s.reason || null, proposalId }));
  }
  const openTodos = (await env.DB.prepare("SELECT id, person_id, tree_id, task, status, version FROM todos WHERE status NOT IN ('done','wont_do')").all()).results
    .filter((row) => canReadTodo(row));
  const seenTasks = new Set(openTodos.map((r) => `${r.person_id}|${r.task}`));
  for (const td of b.todo || []) {
    if (seenTasks.has(`${td.person || null}|${td.task}`)) continue;
    st.push(env.DB.prepare("INSERT INTO todos (person_id, tree_id, task, location, priority, status, branch, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)")
      .bind(td.person || null, td.person ? null : treeId, td.task, td.where || null, td.priority, td.branch || b.branch || null, t, actor, t, actor));
  }
  for (const d of b.todo_done || []) {
    const hits = openTodos.filter((r) => (d.id ? r.id === d.id : (!d.person || r.person_id === d.person) && r.task.startsWith(d.task)));
    if (hits.length !== 1) continue;
    st.push(guard(env, "NOT EXISTS (SELECT 1 FROM todos WHERE id = ? AND version = ?)", hits[0].id, hits[0].version));
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
