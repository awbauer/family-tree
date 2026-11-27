// Per-tree, per-view filtering of the derived bundle. Runs on the FINAL payload, server-side, before anything
// leaves the Worker. Two passes: (1) structural: drop people/links/research outside the scope; (2) a text scrub
// that replaces any remaining name or ID of a hidden person inside free text (issue messages, event notes, story
// bodies, findings). tests/scope.test.mjs asserts no hidden ID or name survives anywhere in the JSON.

import { cleanPlace, placeText } from "./derive.js";

export const DEFAULT_VIEW = { living: "full", research: true, notes: true, media: true, sources: true };

const record = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
const optional = (v, check) => v == null || check(v);
export const validTreeDefinition = (d) => record(d) &&
  ["branches", "include", "exclude"].every((k) => optional(d[k], strings)) && optional(d.root, (x) => typeof x === "string");
export const validViewFilter = (v) => record(v) &&
  optional(v.living, (x) => ["full", "names-only", "anonymous", "hidden"].includes(x)) &&
  ["branches", "exclude_people"].every((k) => optional(v[k], strings)) &&
  ["research", "notes", "media", "sources"].every((k) => !Object.hasOwn(v, k) || typeof v[k] === "boolean") &&
  optional(v.max_generations, (x) => Number.isSafeInteger(x) && x >= 0);

/** The person a merged-away id became (following chains), or the id itself. */
export function followAlias(aliases, id) {
  const seen = new Set();
  while (aliases && Object.hasOwn(aliases, id) && !seen.has(id)) { seen.add(id); id = aliases[id]; }
  return id;
}

/** The people a tree's definition takes in (before any view narrows it). */
export function treeMembers(bundle, def) {
  const P = bundle.people;
  const branches = def.branches || ["*"];
  const all = branches.includes("*");
  const set = new Set(Object.keys(P).filter((id) => all || branches.includes(P[id].branch)));
  for (const id of def.include || []) if (Object.hasOwn(P, id)) set.add(id);
  for (const id of def.exclude || []) set.delete(id);
  return set;
}

// generation distance over parent/child links (spouses cost 0), from a root
function generationDistance(bundle, root) {
  const P = bundle.people, F = bundle.families;
  const dist = new Map([[root, 0]]);
  const dq = [root];
  while (dq.length) {
    const x = dq.shift();
    const d = dist.get(x);
    const p = P[x];
    if (!p) continue;
    const step = (y, w) => {
      if (!y || !P[y]) return;
      const nd = d + w;
      if (!dist.has(y) || dist.get(y) > nd) {
        dist.set(y, nd);
        w === 0 ? dq.unshift(y) : dq.push(y);
      }
    };
    for (const fid of p.famc || []) { const f = F[fid]; if (f) { step(f.husband, 1); step(f.wife, 1); } }
    for (const fid of p.fams || []) {
      const f = F[fid];
      if (!f) continue;
      step(f.husband === x ? f.wife : f.husband, 0);
      for (const c of f.children || []) step(c, 1);
    }
  }
  return dist;
}

const strip = (p, keep) => Object.fromEntries(Object.entries(p).filter(([k]) => keep.includes(k)));

export function scopeBundle(full, { tree, view, viewerPersonId, helpers = {}, isOwner = false }) {
  const v = Object.assign({}, DEFAULT_VIEW, view || {});
  const def = tree.definition || tree;
  const P0 = full.people, F0 = full.families;

  // ---- 1. who is in scope
  let ids = treeMembers(full, def);
  if (v.branches && v.branches.length) ids = new Set([...ids].filter((id) => v.branches.includes(P0[id].branch)));
  for (const id of v.exclude_people || []) ids.delete(id);
  const scopeRoot = (def.root && ids.has(def.root) && def.root) || (ids.has(full.home) && full.home) || [...ids][0];
  if (v.max_generations != null && scopeRoot) {
    const dist = generationDistance(full, scopeRoot);
    ids = new Set([...ids].filter((id) => dist.has(id) && dist.get(id) <= v.max_generations));
  }
  if (v.living === "hidden") ids = new Set([...ids].filter((id) => !P0[id].living));
  const hidden = new Set(Object.keys(P0).filter((id) => !ids.has(id)));
  // living people this view reduces to a name (or to "Living …"): research, stories, media and profiles about them
  // are dropped too, since research covers living relatives like anyone else
  const reduced = new Set([...ids].filter((id) => P0[id].living && (v.living === "names-only" || v.living === "anonymous")));
  const open = (x) => ids.has(x) && !reduced.has(x);

  // ---- 2. families: keep visible members only
  const families = {};
  for (const [fid, f] of Object.entries(F0)) {
    const h = ids.has(f.husband) ? f.husband : null;
    const w = ids.has(f.wife) ? f.wife : null;
    const children = (f.children || []).filter((c) => ids.has(c));
    if (!h && !w && !children.length) continue;
    const fullyVisible = [f.husband, f.wife, ...(f.children || [])].filter(Boolean).every(open);
    const safe = { ...f, husband: h, wife: w, children,
      events: fullyVisible ? (f.events || []).map((event) => scopeFact(event, v)) : [] };
    if (!fullyVisible || !v.notes) delete safe.notes;
    if (!fullyVisible || !v.sources) delete safe.citations;
    if (!fullyVisible || !v.media) delete safe.media;
    if (!fullyVisible) safe.partial = true;
    families[fid] = safe;
  }

  // ---- 3. people, with the view's living/notes/media/sources policy
  const people = {};
  const BASIC = ["id", "name", "given", "surname", "sex", "living", "branch", "famc", "fams", "names", "direct", "generation"];
  for (const id of ids) {
    let p = Object.assign({}, P0[id]);
    p.famc = (p.famc || []).filter((f) => families[f]);
    p.fams = (p.fams || []).filter((f) => families[f]);
    if (p.living && (v.living === "names-only" || v.living === "anonymous")) {
      p = strip(p, BASIC);
      Object.assign(p, { events: [], birth: null, death: null, burial: null, notes: [], media: [], citations: [], issues: [], private: true });
      // The names-only projection is still a full-name display, never a name record with citations or review metadata.
      p.names = (p.names || []).map((name) => strip(name, ["given", "surname", "suffix", "type"]));
      if (v.living === "anonymous") Object.assign(p, { name: `Living ${p.surname || ""}`.trim(), given: "", names: [{ given: "", surname: p.surname || "" }] });
    }
    if (!v.notes || !v.research || [...(p.famc || []), ...(p.fams || [])].some((fid) => {
      const f = F0[fid];
      return f && [f.husband, f.wife, ...(f.children || [])].filter(Boolean).some((person) => !ids.has(person));
    })) delete p.profile;
    if (!v.notes) p.notes = [];
    if (!v.media) p.media = [];
    if (!v.sources) p.citations = [];
    p.events = (p.events || []).map((event) => scopeFact(event, v));
    p.names = (p.names || []).map((name) => scopeFact(name, v));
    for (const field of ["birth", "death", "burial"]) if (p[field]) p[field] = scopeFact(p[field], v);
    if (!v.research) { p.status = "unverified"; p.statusNote = ""; p.issues = []; }
    if (p.duplicateOf) p.duplicateOf = p.duplicateOf.filter((x) => ids.has(x));
    if (p.relationVia && !ids.has(p.relationVia)) delete p.relationVia;
    people[id] = p;
  }

  // ---- 4. relationship labels relative to the viewer (or the tree's root), never to the owner
  const home = (ids.has(viewerPersonId) && viewerPersonId) || (ids.has(scopeRoot) && scopeRoot) || [...ids][0];
  if (helpers.relationLabels && home) {
    const labels = helpers.relationLabels(people, families, home);
    for (const [id, p] of Object.entries(people)) {
      const l = labels[id] || {};
      p.relation = l.relation || null;
      if (l.relationVia && ids.has(l.relationVia)) p.relationVia = l.relationVia; else delete p.relationVia;
    }
  } else if (!isOwner) {
    for (const p of Object.values(people)) { p.relation = null; delete p.relationVia; }
  }

  // ---- 5. research layer
  const R0 = full.research || {};
  const research = {
    site: R0.site, branches: (R0.branches || []).filter((b) => Object.values(people).some((p) => p.branch === b.key)),
    core_people: (R0.core_people || []).filter((x) => ids.has(x)), home_person: home,
    methodology: R0.methodology, context: R0.context || [],
  };
  if (v.research) {
    const treeOk = (t) => !t.tree || t.tree === tree.id;
    research.findings = (R0.findings || []).filter((f) => f.person ? open(f.person) : true);
    research.todo = (R0.todo || []).filter((t) => (t.person ? open(t.person) : treeOk(t)));
    research.todo_done = (R0.todo_done || []).filter((t) => (t.person ? open(t.person) : treeOk(t)));
    research.research_log = (R0.research_log || []).filter((l) => !l.person || open(l.person));
    research.people_status = Object.fromEntries(Object.entries(R0.people_status || {}).filter(([k]) => open(k)));
    research.duplicates = (R0.duplicates || []).filter((d) => d.ids.every((x) => ids.has(x)));
  } else {
    Object.assign(research, { findings: [], todo: [], todo_done: [], research_log: [], people_status: {}, duplicates: [] });
  }
  // a story shows when everyone it's about is in scope; people merged since it was written count as who they became.
  // A story about, or linking, a living person this view reduces to a name is left out as well.
  const linksIn = (body) => [...String(body || "").matchAll(/\[\[([^|\]]+)/g)].map((m) => m[1].trim()); // [[I12|Name]] or [[I12]]
  research.stories = (R0.stories || []).filter((s) => (s.people || []).every((x) => ids.has(followAlias(full.aliases, x)))
    && ![...(s.people || []), ...linksIn(s.body)].some((x) => reduced.has(followAlias(full.aliases, x))));
  research.media = v.media ? Object.fromEntries(Object.entries(R0.media || {}).filter(([k]) => open(k))) : {};

  // ---- 6. sources and GEDCOM media: only what visible people cite, plus sources nobody cites (so they can be
  // tidied up; they point at no one)
  const citingSources = (ppl, fams, mediaMap, into) => {
    const collect = (cites) => (cites || []).forEach((c) => c && c.source && into.add(c.source));
    const fact = (x) => { collect(x.citations); if (x.review) collect(x.review.evidence); };
    for (const p of Object.values(ppl)) { collect(p.citations); (p.names || []).forEach(fact); (p.events || []).forEach(fact); }
    for (const f of Object.values(fams)) (f.events || []).forEach(fact);
    for (const list of Object.values(mediaMap || {})) (list || []).forEach((m) => m && m.source && into.add(m.source));
    return into;
  };
  const citedSources = citingSources(people, families, research.media, new Set()), citedMedia = new Set();
  for (const p of Object.values(people)) (p.media || []).forEach((m) => citedMedia.add(m));
  const citedAnywhere = citingSources(P0, F0, R0.media, new Set());
  const sources = v.sources ? Object.fromEntries(Object.entries(full.sources || {}).filter(([k]) => citedSources.has(k) || !citedAnywhere.has(k))) : {};
  if (!v.sources) research.media = Object.fromEntries(Object.entries(research.media).map(([pid, files]) => [pid,
    files.map((m) => {
      if (!m.source) return m;
      const { source, ...file } = m;
      return file;
    }),
  ]));
  const media = v.media ? Object.fromEntries(Object.entries(full.media || {}).filter(([k]) => citedMedia.has(k))) : {};

  // ---- 7. data-quality issues: re-run on the scoped data when possible (messages embed names)
  let issues;
  if (!v.research) issues = [];
  else if (helpers.checkIssues) {
    try { issues = helpers.checkIssues(people, families, research, full.sources || {}); } catch { issues = null; }
  }
  if (!issues) issues = (full.issues || []).filter((i) => !i.person || ids.has(i.person));
  for (const p of Object.values(people)) if (p.issues) p.issues = issues.filter((i) => i.person === p.id);

  const aliases = Object.fromEntries(Object.entries(full.aliases || {}).filter(([, to]) => ids.has(to)));
  // a view that hides no one gets every place record (places nothing points at yet included); others only theirs
  let places = !hidden.size && !reduced.size && v.media ? full.places : scopePlaces(full.places, people, families, research.media);
  // a place's note is free text like any other note: a view without notes gets none
  if (!v.notes) places = Object.fromEntries(Object.entries(places || {}).map(([k, { note, ...pl }]) => [k, pl]));
  const out = { generated: full.generated, home, people, families, sources, media, issues, aliases, research,
    places, scope: { tree: tree.id, treeName: tree.name, view: v } };

  // ---- 8. text scrub: no hidden person's name or ID may survive in any string, nor an anonymous living person's name
  return scrub(out, hidden, full.people, people, v.living === "anonymous" ? reduced : new Set());
}

function scopeFact(fact, v) {
  const result = { ...fact };
  if (!v.notes) delete result.note;
  if (!v.sources) delete result.citations;
  if (!v.research) delete result.review;
  else if (result.review && (!v.sources || !v.notes)) {
    result.review = { ...result.review };
    if (!v.sources) delete result.review.evidence;
    if (!v.notes) delete result.review.note;
  }
  return result;
}

function namesOf(p) {
  const out = new Set();
  if (p.name && p.name !== "Unknown") out.add(p.name);
  for (const n of p.names || []) {
    const g = (n.given || "").trim(), s = (n.surname || "").trim();
    if (g && s && g !== "?") out.add(`${g} ${s}`);
  }
  return out;
}

/** Apply the tree's free-text redaction to data assembled outside scopeBundle (history, queues, comments). */
export function scrubFor(value, full, bundle) {
  const hidden = new Set(Object.keys(full.people).filter((id) => !Object.hasOwn(bundle.people, id)));
  const anonymous = new Set(bundle.scope.view.living === "anonymous"
    ? Object.values(bundle.people).filter((p) => p.private).map((p) => p.id) : []);
  return scrub(value, hidden, full.people, bundle.people, anonymous);
}

export function scrub(out, hidden, allPeople, visiblePeople, nameOnly = new Set()) {
  if (!hidden.size && !nameOnly.size) return out;
  const visibleNames = new Set();
  for (const p of Object.values(visiblePeople)) if (!nameOnly.has(p.id)) for (const n of namesOf(p)) visibleNames.add(n.toLowerCase());
  const hiddenNames = new Set();
  for (const id of [...hidden, ...nameOnly]) for (const n of namesOf(allPeople[id])) {
    if (n.length >= 5 && !visibleNames.has(n.toLowerCase())) hiddenNames.add(n);
  }
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const idRe = hidden.size ? new RegExp(`\\[\\[(${[...hidden].map(esc).join("|")})\\|([^\\]]*)\\]\\]|\\b(${[...hidden].map(esc).join("|")})\\b`, "g") : null;
  const nameRe = hiddenNames.size ? new RegExp(`(?<![\\p{L}])(${[...hiddenNames].sort((a, b) => b.length - a.length).map(esc).join("|")})(?![\\p{L}])`, "giu") : null;
  const clean = (s) => {
    let t = s;
    if (idRe) t = t.replace(idRe, () => "[private]");
    if (nameRe) t = t.replace(nameRe, "[private]");
    return t;
  };
  const walk = (x) => {
    if (typeof x === "string") return clean(x);
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      return Object.fromEntries(Object.entries(x).filter(([k]) => !hidden.has(k)).map(([k, val]) => [k, walk(val)]));
    }
    return x;
  };
  return walk(out);
}

/**
 * Only the places this view's records use (and the places that enclose them), each with only the place texts those
 * records carry. A place saved in the
 * app can be a street address (someone's home), so a place, its point and its texts show only to viewers who can see
 * an event or a photo or document there. People this view hides, or shows as a name only, have no events here by now.
 */
function scopePlaces(all, people, families, mediaMap) {
  const used = new Map();
  const use = (key, texts) => {
    if (!key || !all || !Object.hasOwn(all, key)) return;
    const set = used.get(key) || new Set();
    for (const t of texts) if (t) set.add(placeText(cleanPlace(String(t))));
    used.set(key, set);
  };
  for (const p of Object.values(people)) for (const e of p.events || []) use(e.placeKey, [e.place]);
  for (const f of Object.values(families)) for (const e of f.events || []) use(e.placeKey, [e.place]);
  for (const list of Object.values(mediaMap || {})) for (const m of list || []) {
    for (const k of (m && m.placeKeys) || []) use(k, [m.place, ...(Array.isArray(m.places) ? m.places : [])]);
  }
  // the places that enclose them, for their full names and breadcrumbs (only their names and points: no texts)
  const enclosing = new Set();
  for (const key of [...used.keys()]) for (let at = all[key].parent; at && Object.hasOwn(all, at) && !used.has(at); at = all[at].parent) { used.set(at, new Set()); enclosing.add(at); }
  const out = {};
  for (const [key, set] of used) {
    const { texts, note, ...pl } = all[key];
    if (enclosing.has(key)) { out[key] = pl; continue; }
    if (note) pl.note = note;
    const shown = (texts || []).filter((t) => set.has(placeText(cleanPlace(String(t)))));
    out[key] = shown.length ? { ...pl, texts: shown } : pl;
  }
  return out;
}
