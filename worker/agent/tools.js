// What the research agent can see, and how its submission is checked. Plain functions over a scoped bundle, so they
// run (and are tested) without the agent runtime; agents/src/agents/researcher.js wraps them as Flue tools.
// The agent reads the tree only as the editor who started the run can see it, and living people are reduced to an
// id and a name: enough to walk through the family, nothing to research.
import * as Graph from "../graph.js";
import { validateBatch } from "../research.js";
import { referencedIds, applyOps, OpError } from "../ops.js";
import { loadEditable } from "../store.js";

const norm = (x) => String(x || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const isHidden = (p) => !p || p.living || p.private;
const years = (p) => [p.birth && p.birth.year, p.death && p.death.year];
const brief = (b, id) => {
  const p = b.people[id];
  if (!p) return null;
  if (isHidden(p)) return { id, name: p.name, living: true };
  const [born, died] = years(p);
  return { id, name: p.name, born: born || undefined, died: died || undefined };
};

function family(b, p) {
  const F = b.families, out = { parents: [], spouses: [], children: [], siblings: [] };
  for (const fid of p.famc || []) {
    const f = F[fid];
    if (!f) continue;
    for (const x of [f.husband, f.wife]) if (x) out.parents.push(brief(b, x));
    for (const x of f.children || []) if (x !== p.id) out.siblings.push(brief(b, x));
  }
  for (const fid of p.fams || []) {
    const f = F[fid];
    if (!f) continue;
    const sp = f.husband === p.id ? f.wife : f.husband;
    const m = (f.events || []).find((e) => e.type === "Marriage");
    if (sp) out.spouses.push(Object.assign(brief(b, sp) || {}, m ? { married: [m.date, m.place].filter(Boolean).join(", ") } : {}));
    for (const x of f.children || []) out.children.push(brief(b, x));
  }
  return out;
}

const cite = (b, c) => {
  const s = (b.sources || {})[c.source] || {};
  return [s.title || c.source, c.page, c.text && `“${c.text}”`, c.url].filter(Boolean).join(" · ");
};

export function personView(b, id) {
  const p = b.people[id];
  if (!p) return { error: `There's no person ${id} in this tree (or you can't see them).` };
  if (isHidden(p)) return { id, name: p.name, living: true, note: "Living person: no details are shared and they must not be researched. Use them only to reach their relatives.", family: family(b, p) };
  const R = b.research || {};
  return {
    id, name: p.name, sex: p.sex || "unknown",
    other_names: (p.names || []).slice(1).map((n) => `${n.given || ""} ${n.surname || ""}`.trim()).filter(Boolean),
    branch: p.branch,
    events: (p.events || []).map((e) => ({ fid: e.fid, type: e.type, date: e.date, place: e.place, detail: e.value, note: e.note, sources: (e.citations || []).map((c) => cite(b, c)) })),
    sources: (p.citations || []).map((c) => cite(b, c)),
    notes: p.notes || [],
    status: p.status, status_note: p.statusNote || undefined,
    family: family(b, p),
    findings: (R.findings || []).filter((f) => f.person === id).map(({ person, ...f }) => f),
    searches_already_logged: (R.research_log || []).filter((l) => l.person === id).map(({ person, id: _, ...l }) => l),
    open_todos: (R.todo || []).filter((t) => t.person === id).map((t) => ({ id: t.id, task: t.task, where: t.where, priority: t.priority, status: t.status })),
    data_warnings: (p.issues || []).map((i) => i.message || i.kind),
  };
}

export function searchPeople(b, query) {
  const terms = norm(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return { matches: [] };
  const hits = [];
  for (const p of Object.values(b.people)) {
    const hay = norm([p.name, ...(p.names || []).map((n) => `${n.given || ""} ${n.surname || ""}`)].join(" | "));
    if (terms.every((t) => hay.includes(t))) hits.push(brief(b, p.id));
    if (hits.length >= 20) break;
  }
  return { matches: hits };
}

export function relationship(b, from, to, cache = {}) {
  if (!b.people[from] || !b.people[to]) return { error: "Both people must be in this tree." };
  const idx = cache.idx || (cache.idx = Graph.buildIndex(b.people, b.families));
  const r = Graph.relationshipPath(idx, from, to);
  if (!r.found) return { found: false };
  return { found: true, summary: Graph.explain(r, b.people), label: r.label, chain: [from, ...r.steps.map((s) => s.to)].map((x) => brief(b, x)) };
}

/** Check a submission. Returns {ok: true, value} or {ok: false, errors}. */
export async function checkSubmission(env, b, input) {
  const errors = [];
  const value = { summary: String((input && input.summary) || "").trim() };
  if (!value.summary) errors.push("summary: say what you did and found");
  const batch = input && input.batch && typeof input.batch === "object" ? input.batch : null;
  const edits = input && input.edits && typeof input.edits === "object" ? input.edits : null;
  const hasBatch = batch && ["findings", "log", "todo", "people_status"].some((k) => batch[k] && Object.keys(batch[k]).length);
  if (!hasBatch && !edits) errors.push("submit at least a research log (batch.log), even if every search came back nil");

  if (hasBatch) {
    const clean = {};
    for (const k of ["findings", "log", "todo", "people_status"]) if (batch[k]) clean[k] = batch[k];
    clean.agent = "cloud";
    const visible = (pid) => !!b.people[pid] && !b.people[pid].private;
    errors.push(...validateBatch(clean, visible));
    for (const [i, f] of (clean.findings || []).entries()) {
      if (f.person && b.people[f.person] && b.people[f.person].living) errors.push(`findings[${i}]: ${f.person} is living. Research is about people who have died.`);
    }
    if (!(clean.log || []).length) errors.push("batch.log: log every search you ran, including nil results");
    value.batch = clean;
  }

  if (edits) {
    if (!Array.isArray(edits.ops) || !edits.ops.length) errors.push("edits.ops: give at least one operation, or leave edits out");
    else {
      if (!String(edits.reason || "").trim()) errors.push("edits.reason: say what record supports the change");
      if (!(edits.sources || []).length) errors.push("edits.sources: cite the record(s) you retrieved");
      if (edits.ops.some((o) => o && o.op === "person.delete")) errors.push("edits.ops: never delete people; propose person.merge for duplicates");
      const { people, families } = referencedIds(edits.ops);
      for (const pid of people) {
        if (!b.people[pid]) errors.push(`edits: person ${pid} isn't in this tree`);
        else if (b.people[pid].private || b.people[pid].living) errors.push(`edits: ${pid} is living; leave their details alone`);
      }
      for (const fid of families) if (!b.families[fid]) errors.push(`edits: family ${fid} isn't in this tree`);
      if (!errors.length) {
        try {
          const { state } = await loadEditable(env);
          applyOps(state, edits.ops, { actor: "agent:cloud" });
        } catch (e) {
          if (e instanceof OpError) errors.push(`edits: ${e.message}`);
          else throw e;
        }
      }
      value.edits = { reason: edits.reason, sources: edits.sources, ops: edits.ops };
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value };
}
