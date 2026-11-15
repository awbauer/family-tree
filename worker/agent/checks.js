// Tree checks for the data quality review: problems in the tree's structure and records, found by code, which the
// agent then confirms or dismisses one at a time (like an open to-do or finding). Plain functions over the derived
// bundle, so they run and are tested without the agent runtime.
//
// Each check is an item {ref: "check:<kind>:<key>", type: "check", kind, person, text, version, detail}. `version` is a
// hash of what the check found, so a decision made in a dry run is only applied while the problem is still the same.
// `detail.suggested_ops` holds edit ops when the fix is mechanical (merging duplicates, standard dates and places); the
// agent may file them as a suggestion. Nothing here changes the tree.

const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
const yr = (p, k) => (p && p[k] && p[k].year) || null;
const label = (b, id) => (b.people[id] ? `${b.people[id].name} (${id}${yr(b.people[id], "birth") ? `, b. ${yr(b.people[id], "birth")}` : ""})` : id);
const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
const item = (kind, key, person, text, detail) => ({ ref: `check:${kind}:${key}`, type: "check", kind, id: `${kind}:${key}`, person, text, detail, version: hash(JSON.stringify(detail)) });

// ---------------------------------------------------------------- dates and places
const MON = { jan: "Jan", feb: "Feb", mar: "Mar", apr: "Apr", may: "May", jun: "Jun", jul: "Jul", aug: "Aug", sep: "Sep", oct: "Oct", nov: "Nov", dec: "Dec",
  // some month names as written in other European languages
  "jún": "Jun", "júl": "Jul", szept: "Sep", okt: "Oct", "már": "Mar", "ápr": "Apr", "máj": "May", febr: "Feb" };
const mon = (s) => {
  const k = String(s).toLowerCase().replace(/\.$/, "");
  if (k.startsWith("szept")) return "Sep";
  return MON[k] || MON[k.slice(0, 4)] || MON[k.slice(0, 3)] || null;
};
const QUAL = { about: "abt", abt: "abt", circa: "abt", ca: "abt", before: "bef", bef: "bef", after: "aft", aft: "aft", estimated: "est", est: "est" };
const STANDARD = /^((abt|bef|aft|est|cal) )?((\d{1,2} )?[A-Z][a-z]{2} )?\d{4}$|^bet \d{4} and \d{4}$|^from \d{4} to \d{4}$/;

/** A date in standard genealogical form ("12 Mar 1891", "abt 1890", "bet 1890 and 1895"), or null when it already is
 *  one or can't be read safely (a date with no year is left alone). `type` decides how a year range is read. */
export function standardDate(d, type) {
  let s = String(d || "").trim().replace(/\s+/g, " ");
  if (!s || STANDARD.test(s)) return null;
  let q = "", m;
  if ((m = s.match(/^(about|abt\.?|circa|ca\.?|before|bef\.?|after|aft\.?|estimated|est\.?)\s+(.*)$/i))) { q = QUAL[m[1].toLowerCase().replace(".", "")] + " "; s = m[2]; }
  let r = null;
  if ((m = s.match(/^(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\.?,?\s+(\d{4})$/)) && mon(m[2])) r = `${+m[1]} ${mon(m[2])} ${m[3]}`;
  else if ((m = s.match(/^([A-Za-zÀ-ÿ]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/)) && mon(m[1])) r = `${+m[2]} ${mon(m[1])} ${m[3]}`;
  else if ((m = s.match(/^([A-Za-zÀ-ÿ]+)\.?,?\s+(\d{4})$/)) && mon(m[1])) r = `${mon(m[1])} ${m[2]}`;
  else if ((m = s.match(/^(\d{4})$/))) r = m[1];
  else if (!q && (m = s.match(/^(\d{4})\s*[-–]\s*(\d{4})$/)) && +m[2] >= +m[1]) return type === "Residence" ? `from ${m[1]} to ${m[2]}` : `bet ${m[1]} and ${m[2]}`;
  const out = r ? q + r : null;
  return out && out !== d ? out : null;
}

// Places: the same place written several ways ("X, AB" / "X, A.B." / "X, Alpha Beta, USA") is found by comparing a key
// that ignores case, dots, "County", a country suffix and abbreviations that match a name's initials. The standard
// spelling is the spelled-out form the tree already uses most. No geography is built in: the tree's own spellings decide.
const COUNTRY = /^(usa|us|u\.s\.a?\.?|united states|united states of america)$/i;
const placeTokens = (pl) => String(pl || "").split(",").map((x) => x.trim()).filter(Boolean)
  .flatMap((x) => { const m = x.match(/^(.*\S)\s+([A-Z]\.?[A-Z]\.?)$/); return m ? [m[1], m[2]] : [x]; }); // "Town AB" -> "Town", "AB"
const tokenKey = (t) => {
  const x = t.replace(/\s+County$/i, "").replace(/\./g, "").trim();
  if (/^[A-Z]{2,3}$/.test(x)) return x.toLowerCase(); // an abbreviation
  const words = x.split(/\s+/);
  // numbers stay in the key: "Lot 12" and "Lot 15" are different places
  const plain = x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  return words.length > 1 && words.every((w) => /^[A-Z]/.test(w)) ? words.map((w) => w[0]).join("").toLowerCase() + "~" : plain;
};
/** Two spellings of the same place share this key. A multi-word name and its initials compare equal ("nj~" ~ "nj"). */
export function placeKey(pl) {
  const toks = placeTokens(pl).filter((t) => !COUNTRY.test(t.replace(/\.$/, "")));
  return toks.map((t) => tokenKey(t).replace(/~$/, "")).join("|");
}
/** {variant: standard} for every place the tree writes more than one way. `uses` counts each spelling. */
export function placeStandards(uses) {
  const groups = {};
  for (const pl of Object.keys(uses)) { const k = placeKey(pl); if (k) (groups[k] = groups[k] || []).push(pl); }
  const out = {};
  for (const list of Object.values(groups)) {
    if (list.length < 2) continue;
    // spelled out beats abbreviated; then the most used; then the fullest
    const abbr = (pl) => placeTokens(pl).some((t) => /^[A-Z]\.?[A-Z]\.?$/.test(t)) ? 1 : 0;
    const best = list.slice().sort((x, y) => abbr(x) - abbr(y) || uses[y] - uses[x] || y.length - x.length || x.localeCompare(y))[0];
    for (const pl of list) if (pl !== best) out[pl] = best;
  }
  return out;
}

// ---------------------------------------------------------------- the checks
function components(b) {
  const P = b.people, F = b.families, comp = new Map();
  let n = 0;
  for (const start of Object.keys(P)) {
    if (comp.has(start)) continue;
    const c = n++, q = [start];
    comp.set(start, c);
    while (q.length) {
      const p = P[q.shift()];
      for (const f of [...(p.famc || []), ...(p.fams || [])]) for (const x of [F[f] && F[f].husband, F[f] && F[f].wife, ...((F[f] && F[f].children) || [])]) if (x && P[x] && !comp.has(x)) { comp.set(x, c); q.push(x); }
    }
  }
  return comp;
}

/** Every tree check that finds something, most serious first. `person` limits them to one person. */
export function treeChecks(b, { person = null } = {}) {
  const P = b.people, F = b.families, out = [];
  const touches = (ids) => !person || ids.includes(person);
  const live = (id) => P[id] && !P[id].private;

  // duplicate people: same first given name and surname, and the same parents, or the same birth year
  const groups = {};
  for (const p of Object.values(P)) {
    if (!live(p.id)) continue;
    for (const n of p.names || []) {
      const k = `${norm(n.given).split(" ")[0]}|${norm(n.surname)}`;
      if (!/^\|/.test(k) && !/\|$/.test(k)) (groups[k] = groups[k] || new Set()).add(p.id);
    }
  }
  const seenPairs = new Set();
  for (const ids of Object.values(groups)) {
    const a = [...ids].sort();
    for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) {
      const x = P[a[i]], y = P[a[j]], key = `${x.id}+${y.id}`;
      if (seenPairs.has(key)) continue;
      const sameParents = (x.famc || []).some((f) => (y.famc || []).includes(f));
      const bx = yr(x, "birth"), by = yr(y, "birth");
      if (!(sameParents && (!bx || !by || Math.abs(bx - by) <= 2)) && !(bx && by && bx === by && (x.famc || []).length + (y.famc || []).length === 0)) continue;
      if (sameParents && bx && by && bx !== by && (yr(x, "death") || yr(y, "death"))) continue; // siblings who reused a name
      seenPairs.add(key);
      if (!touches([x.id, y.id])) continue;
      const [keep, drop] = (x.events || []).length >= (y.events || []).length ? [x, y] : [y, x];
      out.push(item("duplicate-person", key, keep.id, `${label(b, x.id)} and ${label(b, y.id)} may be the same person${sameParents ? " (same parents)" : ""}.`,
        { people: [x.id, y.id], suggested_ops: [{ op: "person.merge", keep: keep.id, drop: drop.id }], severity: "error" }));
    }
  }

  // duplicate families: the same couple recorded twice
  const couples = {};
  for (const f of Object.values(F)) if (f.husband && f.wife) (couples[`${f.husband}+${f.wife}`] = couples[`${f.husband}+${f.wife}`] || []).push(f);
  for (const fams of Object.values(couples)) {
    if (fams.length < 2) continue;
    const [keep, ...rest] = fams.slice().sort((x, y) => (y.children || []).length - (x.children || []).length || String(x.id).localeCompare(String(y.id)));
    if (!touches([keep.husband, keep.wife, ...fams.flatMap((f) => f.children || [])])) continue;
    out.push(item("duplicate-family", fams.map((f) => f.id).sort().join("+"), keep.husband, `${label(b, keep.husband)} and ${label(b, keep.wife)} are recorded as a couple ${fams.length} times (${fams.map((f) => f.id).join(", ")}).`,
      { families: fams.map((f) => ({ id: f.id, children: f.children || [], events: (f.events || []).map((e) => e.type) })), suggested_ops: rest.map((f) => ({ op: "family.merge", keep: keep.id, drop: f.id })), severity: "error" }));
  }
  const dupFamilyKids = new Set(Object.values(couples).filter((x) => x.length > 1).flatMap((x) => x.flatMap((f) => f.children || [])));

  // husband and wife the wrong way round (the husband recorded female and the wife male): one swap fixes both
  const swapped = new Set();
  for (const f of Object.values(F)) {
    const h = P[f.husband], w = P[f.wife];
    if (!h || !w || h.sex !== "F" || w.sex !== "M" || !touches([h.id, w.id])) continue;
    swapped.add(h.id); swapped.add(w.id);
    out.push(item("swapped-spouses", f.id, h.id, `In family ${f.id}, ${label(b, h.id)} is recorded as the husband and ${label(b, w.id)} as the wife, but their sexes are the other way round.`,
      { people: [h.id, w.id], suggested_ops: [{ op: "family.swap_spouses", family: f.id }], severity: "error" }));
  }

  // the tree's own record checks (derive.js), one item per person and kind; date formats are handled below
  const SKIP = new Set(["date-format", "possible-duplicate"]);
  const byPerson = {};
  for (const i of b.issues || []) {
    if (!i.person || !live(i.person) || SKIP.has(i.kind) || i.severity === "info" || !touches([i.person])) continue;
    if (i.kind === "multiple-parents" && dupFamilyKids.has(i.person)) continue; // covered by duplicate-family
    if (i.kind === "sex-role" && swapped.has(i.person)) continue; // covered by swapped-spouses
    const k = `${i.kind}:${i.person}`;
    (byPerson[k] = byPerson[k] || { kind: i.kind, person: i.person, severity: i.severity, messages: [] }).messages.push(i.message);
  }
  for (const v of Object.values(byPerson)) out.push(item(v.kind, v.person, v.person, `${label(b, v.person)}: ${v.messages.join(" ")}`, { people: [v.person], messages: v.messages, severity: v.severity }));

  // the same vital event recorded more than once, with different details
  for (const p of Object.values(P)) {
    if (!live(p.id) || !touches([p.id])) continue;
    for (const t of ["Birth", "Death", "Burial"]) {
      const evs = (p.events || []).filter((e) => e.type === t);
      if (evs.length < 2) continue;
      const distinct = new Set(evs.map((e) => `${e.date || ""}|${e.place || ""}`));
      out.push(item("repeated-event", `${p.id}:${t}`, p.id, `${label(b, p.id)} has ${evs.length} ${t} events${distinct.size === 1 ? " with the same date and place" : ""}.`,
        { people: [p.id], events: evs.map((e) => ({ fid: e.fid, date: e.date, place: e.place, sources: (e.citations || []).length })), severity: "warn" }));
    }
  }

  // records with nothing in them: no facts, no names beyond a placeholder, no family links
  for (const p of Object.values(P)) {
    if (!live(p.id) || !touches([p.id])) continue;
    if (!(p.events || []).length && !(p.famc || []).length && !(p.fams || []).length && !(p.media || []).length)
      out.push(item("empty-record", p.id, p.id, `${label(b, p.id)} has no facts and no family links.`, { people: [p.id], severity: "warn" }));
  }

  // people not connected to the home person at all
  if (b.home && P[b.home]) {
    const comp = components(b), home = comp.get(b.home), clusters = {};
    for (const [id, c] of comp) if (c !== home && live(id)) (clusters[c] = clusters[c] || []).push(id);
    for (const ids of Object.values(clusters)) {
      if (!touches(ids)) continue;
      ids.sort((x, y) => (P[y].events || []).length - (P[x].events || []).length);
      out.push(item("disconnected", ids.slice().sort()[0], ids[0], `${ids.length} ${ids.length === 1 ? "person is" : "people are"} not connected to the home person: ${ids.slice(0, 6).map((x) => label(b, x)).join(", ")}${ids.length > 6 ? ", …" : ""}.`,
        { people: ids.slice(0, 40), size: ids.length, severity: "warn" }));
    }
  }

  // dates and places in standard form: mechanical fixes, batched so one decision covers many events
  const dateOps = [], placeOps = [], uses = {};
  for (const x of [...Object.values(P), ...Object.values(F)]) for (const e of x.events || []) if (e.place) uses[e.place] = (uses[e.place] || 0) + 1;
  const standardOf = placeStandards(uses);
  const scan = (entity, id, e) => {
    const d = e.date && standardDate(e.date, e.type);
    if (d) dateOps.push({ op: "event.update", entity, id, fid: e.fid, set: { date: d }, was: e.date });
    const pl = e.place && standardOf[e.place];
    if (pl) placeOps.push({ op: "event.update", entity, id, fid: e.fid, set: { place: pl }, was: e.place });
  };
  for (const p of Object.values(P)) if (live(p.id) && touches([p.id])) for (const e of p.events || []) if (e.fid) scan("person", p.id, e);
  for (const f of Object.values(F)) if (touches([f.husband, f.wife].filter(Boolean))) for (const e of f.events || []) if (e.fid) scan("family", f.id, e);
  const chunks = (ops, n = 40) => Array.from({ length: Math.ceil(ops.length / n) }, (_, i) => ops.slice(i * n, i * n + n));
  for (const [kind, ops, what] of [["date-format", dateOps, "dates"], ["place-format", placeOps, "places"]]) {
    chunks(ops).forEach((c, i) => out.push(item(kind, String(i + 1), c[0].entity === "person" ? c[0].id : null,
      `${c.length} ${what} could be written in standard form, e.g. "${c[0].was}" → "${Object.values(c[0].set)[0]}".`,
      { examples: c.slice(0, 8).map((o) => `${o.was} → ${Object.values(o.set)[0]}`), suggested_ops: c.map(({ was, ...o }) => o), severity: "info" })));
  }

  const RANK = { error: 0, warn: 1, info: 2 };
  return out.sort((x, y) => RANK[x.detail.severity] - RANK[y.detail.severity] || x.ref.localeCompare(y.ref));
}
