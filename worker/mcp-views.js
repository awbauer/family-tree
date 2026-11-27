// What the MCP server's read tools return: plain functions over a scoped bundle (worker/scope.js), so every answer
// stays inside what the caller may see, and they run (and are tested) without a request. A person their view reduces
// to a name comes through as {id, name, private: true}: enough to walk through the family, nothing more.
import { documentType, documentsFor } from "./documents.ts";
import * as Graph from "./graph.js";
import { relationship } from "./agent/tools.js";
import * as TS from "./textsearch.ts";

const norm = (x) => String(x || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const has = (v) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length);
/** Drop empty fields, so answers stay short. */
export const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => has(v)));
/** A photo's or attachment's transcript, shortened for listings: the full text comes with get_media / get_attachment. */
export const TRANSCRIPT_EXCERPT = 1500;
export function withTranscriptExcerpt(m) {
  if (!m || !m.transcript || m.transcript.length <= TRANSCRIPT_EXCERPT) return m;
  return { ...m, transcript: `${m.transcript.slice(0, TRANSCRIPT_EXCERPT)}…`, transcript_truncated: true, transcript_length: m.transcript.length };
}
const yearOf = (e) => (e && e.sort ? Math.floor(e.sort / 10000) : null);
const clampInt = (v, d, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(+v) && v !== null && v !== "" ? Math.floor(+v) : d));

export function brief(b, id) {
  const p = b.people[id];
  if (!p) return null;
  if (p.private) return { id, name: p.name, private: true };
  return compact({ id, name: p.name, sex: p.sex, born: p.birth && p.birth.year, died: p.death && p.death.year, living: p.living || undefined });
}

const cite = (b, c) => {
  if (!c) return null;
  const s = (c.source && (b.sources || {})[c.source]) || {};
  return compact({ source: c.source, title: s.title || c.title, page: c.page, text: c.text, url: c.url || s.url, note: c.note,
    personal: c.personal || undefined, by: c.by, accessed: c.accessed, source_type: c.source_type, information: c.information,
    evidence: c.evidence, quality: c.quality });
};
const review = (r) => r && compact({ status: r.status, by: r.by, at: r.at, note: r.note, finding: r.finding });

export function eventOut(b, e) {
  return compact({ fid: e.fid, type: e.type, date: e.date, place: e.place, value: e.value, age: e.age, note: e.note,
    year: yearOf(e) || undefined, citations: (e.citations || []).map((c) => cite(b, c)), review: review(e.review) });
}

// ---------------------------------------------------------------- the tree as a whole
export function overview(b) {
  const P = Object.values(b.people), R = b.research || {};
  const status = {};
  for (const p of P) if (!p.private) status[p.status || "unverified"] = (status[p.status || "unverified"] || 0) + 1;
  const yrs = P.flatMap((p) => [p.birth && p.birth.year, p.death && p.death.year]).filter(Boolean);
  const issues = {};
  for (const i of b.issues || []) issues[i.severity || "info"] = (issues[i.severity || "info"] || 0) + 1;
  return compact({
    tree: b.scope.tree, name: b.scope.treeName, view: b.scope.view,
    home_person: brief(b, b.home), core_people: (R.core_people || []).map((x) => brief(b, x)),
    counts: { people: P.length, families: Object.keys(b.families).length, sources: Object.keys(b.sources || {}).length,
      living: P.filter((p) => p.living).length, private: P.filter((p) => p.private).length, direct_line: P.filter((p) => p.direct).length,
      stories: (R.stories || []).length, findings_open: (R.findings || []).filter((f) => !f.resolution || f.resolution.status === "open").length,
      todos_open: (R.todo || []).length },
    years: yrs.length ? { earliest: Math.min(...yrs), latest: Math.max(...yrs) } : undefined,
    research_status: status, data_issues: issues,
    branches: (R.branches || []).map((x) => compact({ key: x.key, name: x.name || x.label, people: P.filter((p) => p.branch === x.key).length })),
    methodology: R.methodology, context: R.context,
  });
}

// ---------------------------------------------------------------- finding people
/** Name search plus filters. Every filter given must match. */
export function search(b, q = {}) {
  const terms = norm(q.query).split(/\s+/).filter(Boolean);
  // With sounds_like, the name words come from the shared search: spelling variants and sound-alikes count too.
  const alike = q.sounds_like && terms.length ? new Set(TS.search(index(b), q.query, { kinds: ["person"], namesOnly: true }).map((h) => h.id)) : null;
  const inRange = (y, from, to) => (from == null || (y != null && y >= +from)) && (to == null || (y != null && y <= +to));
  const place = norm(q.place);
  const out = [];
  for (const p of Object.values(b.people)) {
    const names = [p.name, ...(p.names || []).map((n) => `${n.given || ""} ${n.surname || ""}`)];
    if (alike ? !alike.has(p.id) : terms.length && !terms.every((t) => norm(names.join(" | ")).includes(t))) continue;
    if (q.surname && !(p.names || []).some((n) => norm(n.surname) === norm(q.surname)) && norm(p.surname) !== norm(q.surname)) continue;
    if (q.given && !norm([p.given, ...(p.names || []).map((n) => n.given)].join(" ")).includes(norm(q.given))) continue;
    if (p.private && (q.born_from != null || q.born_to != null || q.died_from != null || q.died_to != null || place || q.status)) continue;
    if (!inRange(p.birth && p.birth.year, q.born_from, q.born_to)) continue;
    if (!inRange(p.death && p.death.year, q.died_from, q.died_to)) continue;
    if (place && !(p.events || []).some((e) => norm(e.place).includes(place))) continue;
    if (q.branch && p.branch !== q.branch) continue;
    if (q.sex && p.sex !== q.sex) continue;
    if (q.living != null && !!p.living !== !!q.living) continue;
    if (q.direct_line && !p.direct) continue;
    if (q.status && p.status !== q.status) continue;
    out.push(p);
  }
  out.sort((x, y) => ((x.birth && x.birth.sort) || 9e9) - ((y.birth && y.birth.sort) || 9e9) || String(x.name).localeCompare(String(y.name)));
  const limit = clampInt(q.limit, 25, 1, 200), offset = clampInt(q.offset, 0, 0, 1e6);
  return {
    total: out.length, offset,
    people: out.slice(offset, offset + limit).map((p) => (p.private ? brief(b, p.id)
      : compact({ ...brief(b, p.id), birthplace: p.birth && p.birth.place, deathplace: p.death && p.death.place, relation: p.relation, branch: p.branch, status: p.status }))),
  };
}

// ---------------------------------------------------------------- searching everything
const indexes = new WeakMap();
const index = (b) => { if (!indexes.has(b)) indexes.set(b, TS.buildIndex(b)); return indexes.get(b); };

/** Full-text search over everything the caller's view shows (worker/textsearch.ts), with what matched in each record. */
export function searchText(b, q = {}) {
  const kinds = Array.isArray(q.kinds) && q.kinds.length ? q.kinds : undefined;
  const hits = TS.search(index(b), q.query || "", { kinds, variants: q.variants !== false });
  const limit = clampInt(q.limit, 25, 1, 100), offset = clampInt(q.offset, 0, 0, 1e6);
  return {
    total: hits.length, offset,
    results: hits.slice(offset, offset + limit).map((h) => compact({
      kind: h.kind, id: h.id, title: h.title, person: h.kind === "person" ? undefined : h.person && brief(b, h.person),
      private: h.private, score: Math.round(h.score * 10) / 10,
      matched: h.matches.map((m) => compact({ in: m.field, text: m.snippet, how: m.how === "exact" ? undefined : m.how === "sounds" ? "sounds like" : "spelled close to", word: m.word })),
    })),
  };
}

// ---------------------------------------------------------------- people and families
function familyOf(b, fid, self) {
  const f = b.families[fid];
  if (!f) return null;
  return compact({
    id: fid, husband: brief(b, f.husband), wife: brief(b, f.wife), children: (f.children || []).map((x) => brief(b, x)),
    events: (f.events || []).map((e) => eventOut(b, e)), relationship: f.relationship || f.type,
    spouse: self ? brief(b, f.husband === self ? f.wife : f.husband) : undefined,
  });
}

/** One person in full: everything a genealogist works from, with the fids and family ids an edit needs. */
export function person(b, id, { comments } = {}) {
  const p = b.people[id];
  if (!p) return null;
  if (p.private) return { id, name: p.name, private: true, note: "This view shows them as a name only: no details can be read or changed.", parents_families: (p.famc || []).map((f) => familyOf(b, f)), own_families: (p.fams || []).map((f) => familyOf(b, f, id)) };
  const R = b.research || {};
  const merged = Object.entries(b.aliases || {}).filter(([, to]) => to === id).map(([from]) => from);
  return compact({
    id, name: p.name, sex: p.sex, living: p.living, relation_to_home_person: p.relation, branch: p.branch,
    direct_line: p.direct || undefined, generation: p.generation,
    names: (p.names || []).map((n) => compact({ fid: n.fid, given: n.given, surname: n.surname, suffix: n.suffix, type: n.type,
      citations: (n.citations || []).map((c) => cite(b, c)), review: review(n.review) })),
    birth: p.birth && compact({ date: p.birth.date, place: p.birth.place }), death: p.death && compact({ date: p.death.date, place: p.death.place }),
    burial: p.burial && compact({ date: p.burial.date, place: p.burial.place }),
    events: (p.events || []).map((e) => eventOut(b, e)),
    citations: (p.citations || []).map((c) => cite(b, c)),
    notes: p.notes,
    attachments: documentsFor(b, id).map(withTranscriptExcerpt),
    media: [
      ...(((b.research && b.research.media) || {})[id] || []).filter((m) => !documentType(m.file)).map((m) => compact(withTranscriptExcerpt({ file: m.file, caption: m.caption, type: m.type, date: m.date, place: m.place, note: m.note, source: m.source, main: m.portrait || undefined, transcript: m.transcript }))),
      ...(p.media || []).map((mid) => (b.media || {})[mid]).filter(Boolean).map((m) => compact({ id: m.id, file: m.file, caption: m.title, type: m.type, date: m.date, place: m.place, imported: true })),
    ],
    profile: p.profile && p.profile.text,
    research_status: p.status, status_note: p.statusNote,
    parents_families: (p.famc || []).map((f) => familyOf(b, f)),
    own_families: (p.fams || []).map((f) => familyOf(b, f, id)),
    findings: (R.findings || []).filter((f) => f.person === id).map(findingOut),
    research_log: (R.research_log || []).filter((l) => l.person === id).map(({ person: _, ...l }) => l),
    todos: (R.todo || []).filter((t) => t.person === id).map((t) => compact({ id: t.id, task: t.task, where: t.where, priority: t.priority, status: t.status, assignee: t.assignee })),
    stories: (R.stories || []).filter((s) => (s.people || []).includes(id)).map((s) => ({ slug: s.slug, title: s.title })),
    data_issues: (p.issues || []).map((i) => compact({ severity: i.severity, kind: i.kind, message: i.message })),
    possible_duplicates: (p.duplicateOf || []).map((x) => brief(b, x)),
    merged_from: merged, comments,
  });
}

/** A family by its F id, or a person's immediate family: parents, siblings (full and half), spouses, children. */
export function family(b, id) {
  if (b.families[id]) return familyOf(b, id);
  const p = b.people[id];
  if (!p) return null;
  const parents = [], siblings = new Map(), spouses = [], children = [];
  const myParents = new Set();
  for (const fid of p.famc || []) {
    const f = b.families[fid];
    if (!f) continue;
    for (const x of [f.husband, f.wife]) if (x) { parents.push({ ...brief(b, x), family: fid }); myParents.add(x); }
    for (const c of f.children || []) if (c !== id) siblings.set(c, { ...brief(b, c), type: "full", family: fid });
  }
  // half siblings: other families of each parent
  for (const par of myParents) for (const fid of (b.people[par] && b.people[par].fams) || []) {
    if ((p.famc || []).includes(fid)) continue;
    for (const c of (b.families[fid] && b.families[fid].children) || []) if (c !== id && !siblings.has(c)) siblings.set(c, { ...brief(b, c), type: "half", family: fid });
  }
  for (const fid of p.fams || []) {
    const f = b.families[fid];
    if (!f) continue;
    const sp = f.husband === id ? f.wife : f.husband;
    const m = (f.events || []).find((e) => e.type === "Marriage");
    spouses.push(compact({ ...(brief(b, sp) || {}), family: fid, married: m && [m.date, m.place].filter(Boolean).join(", ") }));
    for (const c of f.children || []) children.push({ ...brief(b, c), family: fid });
  }
  return { person: brief(b, id), parents, siblings: [...siblings.values()], spouses, children };
}

// ---------------------------------------------------------------- pedigree and descendancy
/** Ancestors with Ahnentafel numbers (1 = the person, 2n = father, 2n+1 = mother) through each person's first parent
 *  family. A person reached twice (pedigree collapse) is listed under every number, marked `repeat`. */
export function ancestors(b, id, generations = 4) {
  if (!b.people[id]) return null;
  const n = clampInt(generations, 4, 1, 12);
  const out = [], seen = new Set();
  let level = [[id, 1]];
  for (let g = 0; g <= n && level.length; g++) {
    const next = [];
    for (const [pid, num] of level) {
      const p = b.people[pid];
      const row = compact({ ahnentafel: num, generation: g, ...brief(b, pid), birthplace: p && !p.private && p.birth && p.birth.place, deathplace: p && !p.private && p.death && p.death.place, repeat: seen.has(pid) || undefined });
      out.push(row);
      if (seen.has(pid)) continue;
      seen.add(pid);
      const f = p && b.families[(p.famc || [])[0]];
      if (!f) continue;
      let father = f.husband, mother = f.wife;
      if (father && b.people[father] && b.people[father].sex === "F" && !(mother && b.people[mother] && b.people[mother].sex === "F")) [father, mother] = [mother, father];
      if (father) next.push([father, num * 2]);
      if (mother) next.push([mother, num * 2 + 1]);
    }
    level = next;
  }
  const missing = [];
  const nums = new Set(out.map((r) => r.ahnentafel));
  for (const r of out) if (r.generation < n && !r.repeat) for (const k of [r.ahnentafel * 2, r.ahnentafel * 2 + 1]) if (!nums.has(k)) missing.push(k);
  return { person: brief(b, id), generations: n, ancestors: out.slice(1), unknown_ancestor_numbers: missing.slice(0, 200) };
}

/** Descendants generation by generation, with each one's parents and spouses, numbered d'Aboville style (1.2.1). */
export function descendants(b, id, generations = 3) {
  if (!b.people[id]) return null;
  const n = clampInt(generations, 3, 1, 12);
  const out = [], seen = new Set([id]);
  const walk = (pid, label, g) => {
    if (g >= n || out.length >= 1000) return;
    let k = 0;
    for (const fid of (b.people[pid] && b.people[pid].fams) || []) {
      const f = b.families[fid];
      if (!f) continue;
      const other = f.husband === pid ? f.wife : f.husband;
      for (const c of f.children || []) {
        if (seen.has(c)) continue;
        seen.add(c);
        const num = `${label}.${++k}`;
        const cp = b.people[c];
        out.push(compact({ number: num, generation: g + 1, ...brief(b, c), parents: [brief(b, pid), other && brief(b, other)].filter(Boolean).map((x) => x.id),
          spouses: ((cp && cp.fams) || []).map((sf) => b.families[sf]).filter(Boolean).map((sf) => (sf.husband === c ? sf.wife : sf.husband)).filter(Boolean).map((s) => brief(b, s)) }));
        walk(c, num, g + 1);
      }
    }
  };
  walk(id, "1", 0);
  return { person: brief(b, id), generations: n, count: out.length, descendants: out };
}

export function relate(b, from, to) {
  const r = relationship(b, from, to);
  if (r.error || !r.found) return r;
  const idx = Graph.buildIndex(b.people, b.families);
  const common = Graph.commonAncestors(idx, from, to).map((x) => ({ ...brief(b, x.id), generations_from_first: x.fromA, generations_from_second: x.fromB }));
  return { ...r, from: brief(b, from), to: brief(b, to), common_ancestors: common };
}

// ---------------------------------------------------------------- timeline
/** A life in order: the person's own events, then the family's (parents' deaths, marriages, children's births and
 *  deaths, spouses' deaths), each with the person's age when the date allows. */
export function timeline(b, id) {
  const p = b.people[id];
  if (!p) return null;
  if (p.private) return { person: brief(b, id), events: [] };
  const bs = p.birth && p.birth.sort, ds = p.death && p.death.sort;
  const ageAt = (s) => (bs && s && s >= bs ? Math.floor((s - bs) / 10000) : undefined);
  const rows = [];
  const add = (e, extra) => rows.push(compact({ sort: e.sort, date: e.date, type: e.type, place: e.place, value: e.value, note: e.note, age: ageAt(e.sort), ...extra }));
  for (const e of p.events || []) add(e, { whose: "self", fid: e.fid });
  const other = (pid, rel, types) => {
    const x = b.people[pid];
    if (!x || x.private) return;
    for (const e of x.events || []) if (types.includes(e.type) && e.sort && (!ds || e.sort <= ds + 10000 * 60)) add(e, { whose: rel, person: brief(b, pid) });
  };
  for (const fid of p.famc || []) {
    const f = b.families[fid];
    if (!f) continue;
    for (const par of [f.husband, f.wife]) if (par) other(par, "parent", ["Death", "Burial"]);
    for (const s of f.children || []) if (s !== id) other(s, "sibling", ["Birth", "Death"]);
  }
  for (const fid of p.fams || []) {
    const f = b.families[fid];
    if (!f) continue;
    for (const e of f.events || []) add(e, { whose: "family", family: fid, fid: e.fid });
    const sp = f.husband === id ? f.wife : f.husband;
    if (sp) other(sp, "spouse", ["Death", "Burial"]);
    for (const c of f.children || []) other(c, "child", ["Birth", "Death", "Marriage"]);
  }
  const dated = rows.filter((r) => r.sort).sort((x, y) => x.sort - y.sort), undated = rows.filter((r) => !r.sort);
  return { person: brief(b, id), events: [...dated, ...undated].map(({ sort, ...r }) => r) };
}

// ---------------------------------------------------------------- across the tree
/** Events of every visible person and family, by type, place, year range and text. */
export function searchEvents(b, q = {}) {
  const type = norm(q.type), place = norm(q.place), text = norm(q.text);
  const out = [];
  const ok = (e) => (!type || norm(e.type) === type) && (!place || norm(e.place).includes(place))
    && (q.year_from == null || (yearOf(e) && yearOf(e) >= +q.year_from)) && (q.year_to == null || (yearOf(e) && yearOf(e) <= +q.year_to))
    && (!text || norm([e.value, e.note, e.type, e.place].join(" ")).includes(text));
  for (const p of Object.values(b.people)) if (!p.private) for (const e of p.events || []) if (ok(e)) out.push({ e, who: { person: brief(b, p.id) } });
  for (const [fid, f] of Object.entries(b.families)) for (const e of f.events || []) if (ok(e)) out.push({ e, who: { family: fid, husband: brief(b, f.husband), wife: brief(b, f.wife) } });
  out.sort((x, y) => (x.e.sort || 9e9) - (y.e.sort || 9e9));
  const limit = clampInt(q.limit, 50, 1, 500);
  return { total: out.length, events: out.slice(0, limit).map(({ e, who }) => compact({ ...eventOut(b, e), citations: undefined, ...who })) };
}

export function surnames(b, { min_count = 1 } = {}) {
  const m = new Map();
  for (const p of Object.values(b.people)) {
    const s = (p.surname || "").trim() || "(none)";
    const r = m.get(s) || { surname: s, people: 0, earliest: null, latest: null, places: new Map(), branches: new Set() };
    r.people++;
    if (p.branch) r.branches.add(p.branch);
    for (const y of [p.birth && p.birth.year, p.death && p.death.year].filter(Boolean)) {
      r.earliest = r.earliest == null ? y : Math.min(r.earliest, y);
      r.latest = r.latest == null ? y : Math.max(r.latest, y);
    }
    for (const e of p.events || []) if (e.place) r.places.set(e.place, (r.places.get(e.place) || 0) + 1);
    m.set(s, r);
  }
  return { surnames: [...m.values()].filter((r) => r.people >= +min_count).sort((x, y) => y.people - x.people || x.surname.localeCompare(y.surname))
    .map((r) => compact({ surname: r.surname, people: r.people, earliest: r.earliest, latest: r.latest, branches: [...r.branches],
      top_places: [...r.places].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([place, n]) => ({ place, events: n })) })) };
}

export function places(b, { query, unmapped } = {}) {
  const q = norm(query), m = new Map();
  const add = (e, who) => {
    if (!e.place || (q && !norm(e.place).includes(q))) return;
    const r = m.get(e.place) || { place: e.place, key: e.placeKey, events: 0, people: new Set(), types: {}, from: null, to: null };
    r.events++;
    if (who) r.people.add(who);
    r.types[e.type] = (r.types[e.type] || 0) + 1;
    const y = yearOf(e);
    if (y) { r.from = r.from == null ? y : Math.min(r.from, y); r.to = r.to == null ? y : Math.max(r.to, y); }
    m.set(e.place, r);
  };
  for (const p of Object.values(b.people)) if (!p.private) for (const e of p.events || []) add(e, p.id);
  for (const f of Object.values(b.families)) for (const e of f.events || []) add(e, null);
  // photos and documents placed there (media `place` / `places`), for people whose documents this view shows
  const docs = {};
  if (b.scope?.view?.media !== false) for (const [pid, list] of Object.entries((b.research && b.research.media) || {})) {
    if (!b.people[pid] || b.people[pid].private) continue;
    for (const md of list || []) for (const k of md.placeKeys || []) (docs[k] = docs[k] || new Set()).add(md.file);
  }
  const rows = [...m.values()].filter((r) => !unmapped || !(r.key && (b.places || {})[r.key]));
  return { places: rows.sort((x, y) => y.events - x.events).slice(0, 300).map((r) => {
    const geo = r.key && (b.places || {})[r.key];
    return compact({ place: r.place, key: geo ? r.key : undefined, on_map: !!geo, standard: geo && geo.name, lat: geo && geo.lat, lng: geo && geo.lng, events: r.events, people: r.people.size,
      documents: geo && docs[r.key] ? docs[r.key].size : undefined, years: r.from ? `${r.from}–${r.to}` : undefined, types: r.types });
  }), unmapped_total: [...m.values()].filter((r) => !(r.key && (b.places || {})[r.key])).length };
}

export function issues(b, q = {}) {
  const list = (b.issues || []).filter((i) => (!q.person || i.person === q.person) && (!q.kind || i.kind === q.kind) && (!q.severity || i.severity === q.severity));
  const kinds = {};
  for (const i of b.issues || []) kinds[i.kind] = (kinds[i.kind] || 0) + 1;
  return { total: list.length, kinds, issues: list.slice(0, clampInt(q.limit, 100, 1, 1000)).map((i) => compact({ ...i, person: i.person && brief(b, i.person) })) };
}

export function duplicates(b) {
  const pairs = new Map();
  for (const d of (b.research && b.research.duplicates) || []) pairs.set([...d.ids].sort().join("|"), compact({ people: d.ids.map((x) => brief(b, x)), note: d.note || d.reason, source: "research" }));
  for (const p of Object.values(b.people)) for (const x of p.duplicateOf || []) {
    const k = [p.id, x].sort().join("|");
    if (!pairs.has(k)) pairs.set(k, { people: [brief(b, p.id), brief(b, x)], source: "detected" });
  }
  return { candidates: [...pairs.values()], hint: "Merge a real duplicate with a person.merge edit (keep, drop); never delete people." };
}

// ---------------------------------------------------------------- sources
/** Every fact that cites a source, as [{person|family, fid?, where, page}]. */
function citationsOf(b, sid) {
  const out = [];
  const scan = (owner, list, where, fid) => (list || []).forEach((c, index) => { if (c && c.source === sid) out.push(compact({ ...owner, fid, where, index, page: c.page })); });
  for (const p of Object.values(b.people)) {
    if (p.private) continue;
    const o = { person: brief(b, p.id) };
    scan(o, p.citations, "person");
    for (const n of p.names || []) scan(o, n.citations, "name", n.fid);
    for (const e of p.events || []) { scan(o, e.citations, e.type, e.fid); if (e.review) scan(o, e.review.evidence, `${e.type} review`, e.fid); }
    for (const m of ((b.research && b.research.media) || {})[p.id] || []) if (m && m.source === sid) out.push({ ...o, where: documentType(m.file) || "photo", file: m.file, ...(documentType(m.file) ? { caption: m.caption } : {}) });
  }
  for (const [fid, f] of Object.entries(b.families)) for (const e of f.events || []) scan({ family: fid }, e.citations, e.type, e.fid);
  return out;
}

export function sourceList(b, { query } = {}) {
  const q = norm(query);
  const counts = new Map();
  const bump = (c) => c && c.source && counts.set(c.source, (counts.get(c.source) || 0) + 1);
  for (const p of Object.values(b.people)) { (p.citations || []).forEach(bump); for (const x of [...(p.names || []), ...(p.events || [])]) (x.citations || []).forEach(bump); }
  for (const f of Object.values(b.families)) for (const e of f.events || []) (e.citations || []).forEach(bump);
  return { sources: Object.entries(b.sources || {}).filter(([, s]) => !q || norm([s.title, s.author, s.publication, s.repository].join(" ")).includes(q))
    .map(([id, s]) => compact({ id, title: s.title, type: s.type, author: s.author, url: s.url, citations: counts.get(id) || 0 }))
    .sort((x, y) => y.citations - x.citations || String(x.title).localeCompare(String(y.title))) };
}

export function source(b, id) {
  const s = (b.sources || {})[id];
  if (!s) return null;
  return { ...compact({ ...s, id }), cited_by: citationsOf(b, id) };
}

// ---------------------------------------------------------------- research
export const findingOut = (f) => compact({ id: f.id, version: f.version, person: f.person, kind: f.kind, field: f.field, fact: f.fact, claim: f.claim,
  finding: f.finding, confidence: f.confidence, sources: f.sources, proposed_ops: f.proposed_ops, date: f.date, agent: f.agent,
  status: (f.resolution && f.resolution.status) || "open", resolution: f.resolution });

export function findings(b, q = {}) {
  const st = q.status || "open";
  const list = ((b.research && b.research.findings) || []).map(findingOut)
    .filter((f) => (st === "all" || f.status === st) && (!q.person || f.person === q.person) && (!q.kind || f.kind === q.kind));
  return { total: list.length, findings: list.slice(0, clampInt(q.limit, 100, 1, 1000)).map((f) => ({ ...f, person: f.person && brief(b, f.person) })) };
}

export function researchLog(b, q = {}) {
  const list = ((b.research && b.research.research_log) || []).filter((l) => !q.person || l.person === q.person)
    .filter((l) => !q.result || l.result === q.result);
  return { total: list.length, searches: list.slice(-clampInt(q.limit, 200, 1, 2000)).map((l) => compact({ ...l, person: l.person && brief(b, l.person) })) };
}

export function stories(b, { person: pid, query } = {}) {
  const q = norm(query);
  return { stories: ((b.research && b.research.stories) || []).filter((s) => (!pid || (s.people || []).includes(pid)) && (!q || norm(`${s.title} ${s.body}`).includes(q)))
    .map((s) => compact({ slug: s.slug, title: s.title, era: s.era, branch: s.branch, people: (s.people || []).map((x) => brief(b, x)), revised: s.revised })) };
}

export function story(b, slug) {
  const s = ((b.research && b.research.stories) || []).find((x) => x.slug === slug);
  return s ? compact({ ...s, people: (s.people || []).map((x) => brief(b, x)) }) : null;
}
