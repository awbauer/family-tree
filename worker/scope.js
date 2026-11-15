// Per-tree, per-view filtering of the derived bundle. Runs on the FINAL payload, server-side, before anything
// leaves the Worker. Two passes: (1) structural: drop people/links/research outside the scope; (2) a text scrub
// that replaces any remaining name or ID of a hidden person inside free text (issue messages, event notes, story
// bodies, findings). tests/scope.test.mjs asserts no hidden ID or name survives anywhere in the JSON.

export const DEFAULT_VIEW = { living: "full", research: true, notes: true, media: true, sources: true };

function treeMembers(bundle, def) {
  const P = bundle.people;
  const branches = def.branches || ["*"];
  const all = branches.includes("*");
  const set = new Set(Object.keys(P).filter((id) => all || branches.includes(P[id].branch)));
  for (const id of def.include || []) if (P[id]) set.add(id);
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
  const root = (viewerPersonId && ids.has(viewerPersonId) && viewerPersonId) || (def.root && ids.has(def.root) && def.root)
    || (ids.has(full.home) && full.home) || [...ids][0];
  if (v.max_generations != null && root) {
    const dist = generationDistance(full, root);
    ids = new Set([...ids].filter((id) => dist.has(id) && dist.get(id) <= v.max_generations));
  }
  if (v.living === "hidden") ids = new Set([...ids].filter((id) => !P0[id].living));
  const hidden = new Set(Object.keys(P0).filter((id) => !ids.has(id)));

  // ---- 2. families: keep visible members only
  const families = {};
  for (const [fid, f] of Object.entries(F0)) {
    const h = ids.has(f.husband) ? f.husband : null;
    const w = ids.has(f.wife) ? f.wife : null;
    const children = (f.children || []).filter((c) => ids.has(c));
    if (!h && !w && !children.length) continue;
    families[fid] = Object.assign({}, f, { husband: h, wife: w, children, events: v.sources ? f.events : (f.events || []).map(noCites) });
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
      if (v.living === "anonymous") Object.assign(p, { name: `Living ${p.surname || ""}`.trim(), given: "", names: [{ given: "", surname: p.surname || "" }] });
    }
    if (!v.notes) delete p.profile; // AI-written narrative counts as notes
    if (!v.notes) { p.notes = []; p.events = (p.events || []).map((e) => { const { note, ...rest } = e; return rest; }); }
    if (!v.media) p.media = [];
    if (!v.sources) { p.citations = []; p.events = (p.events || []).map(noCites); }
    if (!v.research) { p.status = "unverified"; p.statusNote = ""; p.issues = []; }
    if (p.duplicateOf) p.duplicateOf = p.duplicateOf.filter((x) => ids.has(x));
    if (p.relationVia && !ids.has(p.relationVia)) delete p.relationVia;
    people[id] = p;
  }

  // ---- 4. relationship labels relative to the viewer (or the tree's root), never to the owner
  const home = root;
  if (helpers.relationLabels && home) {
    const labels = helpers.relationLabels(full.people, full.families, home);
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
  const visiblePerson = (x) => !x || ids.has(x);
  const research = {
    site: R0.site, branches: (R0.branches || []).filter((b) => Object.values(people).some((p) => p.branch === b.key)),
    core_people: (R0.core_people || []).filter((x) => ids.has(x)), home_person: home,
    methodology: R0.methodology, context: R0.context || [],
  };
  if (v.research) {
    const treeOk = (t) => !t.tree || t.tree === tree.id;
    research.findings = (R0.findings || []).filter((f) => f.person ? ids.has(f.person) : true);
    research.todo = (R0.todo || []).filter((t) => (t.person ? ids.has(t.person) : treeOk(t)));
    research.todo_done = (R0.todo_done || []).filter((t) => (t.person ? ids.has(t.person) : treeOk(t)));
    research.research_log = (R0.research_log || []).filter((l) => visiblePerson(l.person));
    research.people_status = Object.fromEntries(Object.entries(R0.people_status || {}).filter(([k]) => ids.has(k)));
    research.duplicates = (R0.duplicates || []).filter((d) => d.ids.every((x) => ids.has(x)));
  } else {
    Object.assign(research, { findings: [], todo: [], todo_done: [], research_log: [], people_status: {}, duplicates: [] });
  }
  research.stories = (R0.stories || []).filter((s) => (s.people || []).every((x) => ids.has(x)));
  research.media = v.media ? Object.fromEntries(Object.entries(R0.media || {}).filter(([k]) => ids.has(k))) : {};

  // ---- 6. sources and GEDCOM media: only what visible people cite
  const citedSources = new Set(), citedMedia = new Set();
  const collect = (cites) => (cites || []).forEach((c) => c.source && citedSources.add(c.source));
  for (const p of Object.values(people)) {
    collect(p.citations); (p.events || []).forEach((e) => collect(e.citations)); (p.media || []).forEach((m) => citedMedia.add(m));
  }
  for (const f of Object.values(families)) (f.events || []).forEach((e) => collect(e.citations));
  const sources = v.sources ? Object.fromEntries(Object.entries(full.sources || {}).filter(([k]) => citedSources.has(k))) : {};
  const media = v.media ? Object.fromEntries(Object.entries(full.media || {}).filter(([k]) => citedMedia.has(k))) : {};

  // ---- 7. data-quality issues: re-run on the scoped data when possible (messages embed names)
  let issues;
  if (!v.research) issues = [];
  else if (helpers.checkIssues) {
    try { issues = helpers.checkIssues(people, families, research); } catch { issues = null; }
  }
  if (!issues) issues = (full.issues || []).filter((i) => !i.person || ids.has(i.person));
  for (const p of Object.values(people)) if (p.issues) p.issues = issues.filter((i) => i.person === p.id);

  const aliases = Object.fromEntries(Object.entries(full.aliases || {}).filter(([, to]) => ids.has(to)));
  const out = { generated: full.generated, home, people, families, sources, media, issues, aliases, research,
    places: full.places, scope: { tree: tree.id, treeName: tree.name, view: v } };

  // ---- 8. text scrub: no hidden person's name or ID may survive in any string
  return scrub(out, hidden, full.people, people);
}

function noCites(e) { const { citations, ...rest } = e; return rest; }

function namesOf(p) {
  const out = new Set();
  if (p.name && p.name !== "Unknown") out.add(p.name);
  for (const n of p.names || []) {
    const g = (n.given || "").trim(), s = (n.surname || "").trim();
    if (g && s && g !== "?") out.add(`${g} ${s}`);
  }
  return out;
}

export function scrub(out, hidden, allPeople, visiblePeople) {
  if (!hidden.size) return out;
  const visibleNames = new Set();
  for (const p of Object.values(visiblePeople)) for (const n of namesOf(p)) visibleNames.add(n.toLowerCase());
  const hiddenNames = new Set();
  for (const id of hidden) for (const n of namesOf(allPeople[id])) {
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
      const o = {};
      for (const [k, val] of Object.entries(x)) if (!hidden.has(k)) o[k] = walk(val);
      return o;
    }
    return x;
  };
  return walk(out);
}
