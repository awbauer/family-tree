// GEDCOM X: the conceptual model, the storage shape and the interchange format (docs/design/standards.md).
//
// The app's working model (people with famc/fams, families with husband/wife/children, sources, media) is what
// derive.js, ops.js and the views use. GEDCOM X is what is stored and exchanged. These functions convert between the
// two LOSSLESSLY: toGx then fromGx returns exactly what went in. Anything with no GEDCOM X home rides along as
// namespaced extension members (GEDCOM X JSON allows extension members on its types).
//
// Families become relationships, the graph's edges:
//   husband + wife              → one Couple (id = the family id), carrying the family's facts
//   each parent of each child   → one ParentChild (person1 = parent, person2 = child)
//   a family with one or no spouse (an unknown partner) → an ft:FamilyGroup relationship holding its facts, since
//                                 a Couple needs two people
// Every relationship records its family (ft:family), the parent's role and the child's position, so the family view
// can be rebuilt exactly. "Family" is a derived grouping, the way FamilySearch shows a couple with their children.

export const FT = "https://family-tree.example/terms/";
const GX = "http://gedcomx.org/";
const ft = (k) => FT + k;
export const MEDIA_TYPE = "application/x-gedcomx-v1+json";

// ---------------------------------------------------------------- vocabularies
const FACT_TYPES = ["Adoption", "AdultChristening", "Annulment", "Baptism", "BarMitzvah", "BatMitzvah", "Birth", "Blessing", "Burial",
  "Caste", "Census", "Christening", "Circumcision", "Confirmation", "Cremation", "Death", "Divorce", "DivorceFiling", "Education",
  "Emigration", "Engagement", "Ethnicity", "Excommunication", "FirstCommunion", "Funeral", "GenderChange", "Heimat", "Immigration",
  "Land", "Marriage", "MarriageBanns", "MarriageContract", "MarriageLicense", "MaritalStatus", "Medical", "MilitaryService", "Mission",
  "Moved", "Naturalization", "Nationality", "NumberOfChildren", "NumberOfMarriages", "Occupation", "Ordination", "Pardon",
  "PhysicalDescription", "Probate", "Property", "Religion", "Residence", "Retirement", "Stillbirth", "Will"];
const FACT_ALIAS = { Military: "MilitaryService", Graduation: "Education", Emigrated: "Emigration", Immigrated: "Immigration" };
const FACT_BACK = Object.fromEntries(Object.entries(FACT_ALIAS).map(([a, b]) => [b, a]));
const NAME_TYPES = { birth: "BirthName", married: "MarriedName", "also known as": "AlsoKnownAs", aka: "AlsoKnownAs", nickname: "Nickname", adopted: "AdoptiveName", formal: "FormalName", religious: "ReligiousName" };
const GENDER = { M: "Male", F: "Female", U: "Unknown" };
const REVIEW_CONFIDENCE = { verified: "High", disputed: "Low" };

/** Event type ↔ GEDCOM X fact type URI (ours for anything GEDCOM X doesn't define; the original string survives). */
export function factTypeUri(type) {
  const t = FACT_ALIAS[type] || type;
  return FACT_TYPES.includes(t) ? GX + t : ft(`fact/${encodeURIComponent(type)}`);
}
function factTypeBack(uri, original) {
  if (original != null) return original;
  if (uri && uri.startsWith(GX)) { const t = uri.slice(GX.length); return FACT_BACK[t] || t; }
  if (uri && uri.startsWith(ft("fact/"))) return decodeURIComponent(uri.slice(ft("fact/").length));
  return uri;
}

// ---------------------------------------------------------------- dates
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const two = (n) => String(n).padStart(2, "0");
function simpleDate(s) {
  const m = String(s).trim().match(/^(?:(\d{1,2})\s+)?(?:([A-Za-z]{3})[a-z]*\.?\s+)?(\d{3,4})$/);
  if (!m) return null;
  const y = +m[3], mo = m[2] ? MON[m[2].toLowerCase()] : null, d = m[1] ? +m[1] : null;
  if (m[2] && !mo) return null;
  return `+${String(y).padStart(4, "0")}${mo ? `-${two(mo)}` : ""}${mo && d ? `-${two(d)}` : ""}`;
}
/** A GEDCOM-style date phrase → a GEDCOM X formal date, or undefined when it doesn't parse (the original is kept). */
export function formalDate(text) {
  if (!text) return undefined;
  const s = String(text).trim().replace(/\s+/g, " ");
  let m;
  if ((m = s.match(/^(?:abt|about|est|estimated|cal|calculated|circa|c\.?|ca\.?)\s+(.+)$/i))) { const f = simpleDate(m[1]); return f && `A${f}`; }
  if ((m = s.match(/^(?:bef|before)\.?\s+(.+)$/i))) { const f = simpleDate(m[1]); return f && `/${f}`; }
  if ((m = s.match(/^(?:aft|after)\.?\s+(.+)$/i))) { const f = simpleDate(m[1]); return f && `${f}/`; }
  if ((m = s.match(/^(?:bet|between|from)\.?\s+(.+?)\s+(?:and|to|-)\s+(.+)$/i))) { const a = simpleDate(m[1]), b = simpleDate(m[2]); return a && b ? `${a}/${b}` : undefined; }
  return simpleDate(s) || undefined;
}

// ---------------------------------------------------------------- helpers
const ref = (id) => ({ resource: `#${id}` });
const unref = (r) => (r && r.resource ? String(r.resource).replace(/^#/, "") : null);
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const omit = (o, keys) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !keys.includes(k)));
const nonEmpty = (o) => o && Object.keys(o).length > 0;
/** Keys of `o` not in `known`, kept losslessly under ft:extra. */
const extra = (o, known) => { const e = omit(o, known); return nonEmpty(e) ? { [ft("extra")]: e } : {}; };
const unextra = (g) => g[ft("extra")] || {};

// ---------------------------------------------------------------- citations (SourceReference)
const CITE_KEYS = ["source", "title", "page", "url", "note", "text", "apid", "repository", "accessed", "source_type", "information", "evidence", "quality"];
const CITE_EXT = { title: "title", page: "page", url: "url", note: "note", text: "text", apid: "apid", repository: "repository", accessed: "accessed", source_type: "sourceType", information: "information", evidence: "evidence", quality: "quality" };
function citeToGx(c) {
  // a citation without a catalogued source keeps whatever (possibly empty) source value it had
  const out = c.source ? { description: `#${c.source}` } : c.source !== undefined ? { [ft("source")]: c.source } : {};
  for (const [k, e] of Object.entries(CITE_EXT)) if (c[k] !== undefined) out[ft(e)] = c[k];
  return { ...out, ...extra(c, CITE_KEYS) };
}
function citeFromGx(g) {
  const c = {};
  if (g.description) c.source = String(g.description).replace(/^#/, "");
  else if (g[ft("source")] !== undefined) c.source = g[ft("source")];
  for (const [k, e] of Object.entries(CITE_EXT)) if (g[ft(e)] !== undefined) c[k] = g[ft(e)];
  return { ...c, ...unextra(g) };
}
const citesToGx = (list) => (list || []).map(citeToGx);
const citesFromGx = (list) => (list || []).map(citeFromGx);

// ---------------------------------------------------------------- reviews (conclusion confidence + attribution + evidence)
function reviewToGx(r) {
  if (!r) return {};
  const out = { [ft("reviewStatus")]: r.status };
  if (REVIEW_CONFIDENCE[r.status]) out.confidence = GX + REVIEW_CONFIDENCE[r.status];
  const at = Date.parse(r.at);
  out.attribution = { contributor: { resource: `#agent:${r.by}` }, ...(Number.isFinite(at) ? { modified: at } : {}), ...(r.note ? { changeMessage: r.note } : {}) };
  out[ft("review")] = r; // the exact record (evidence, finding) for a lossless round trip
  return out;
}
const reviewFromGx = (g) => g[ft("review")];

// ---------------------------------------------------------------- facts and names
const EVENT_KEYS = ["type", "date", "place", "place_ref", "note", "value", "age", "subtype", "address", "fid", "citations", "review"];
function eventToGx(e) {
  const g = { id: e.fid, type: factTypeUri(e.type), [ft("type")]: e.type };
  if (e.date !== undefined) { g.date = { original: e.date }; const f = formalDate(e.date); if (f) g.date.formal = f; }
  if (e.place !== undefined || e.place_ref !== undefined) g.place = { ...(e.place !== undefined ? { original: e.place } : {}), ...(e.place_ref ? { descriptionRef: `#${e.place_ref}` } : {}) };
  if (e.value !== undefined) g.value = e.value;
  if (e.note !== undefined) g.notes = [{ text: e.note }];
  if (e.age !== undefined) g.qualifiers = [{ name: GX + "Age", value: e.age }];
  if (e.subtype !== undefined) g[ft("subtype")] = e.subtype;
  if (e.address !== undefined) g[ft("address")] = e.address;
  if (e.citations !== undefined) g.sources = citesToGx(e.citations);
  return clean({ ...g, ...reviewToGx(e.review), ...extra(e, EVENT_KEYS) });
}
function eventFromGx(g) {
  const e = {};
  e.type = factTypeBack(g.type, g[ft("type")]);
  if (g.date) e.date = g.date.original;
  if (g.place && g.place.original !== undefined) e.place = g.place.original;
  if (g.place && typeof g.place.descriptionRef === "string" && g.place.descriptionRef.startsWith("#")) e.place_ref = g.place.descriptionRef.slice(1);
  if (g.notes) e.note = g.notes[0].text;
  if (g.value !== undefined) e.value = g.value;
  const age = (g.qualifiers || []).find((q) => q.name === GX + "Age");
  if (age) e.age = age.value;
  if (g[ft("subtype")] !== undefined) e.subtype = g[ft("subtype")];
  if (g[ft("address")] !== undefined) e.address = g[ft("address")];
  if (g.id !== undefined) e.fid = g.id;
  if (g.sources) e.citations = citesFromGx(g.sources);
  const r = reviewFromGx(g);
  if (r) e.review = r;
  return { ...e, ...unextra(g) };
}
const NAME_KEYS = ["given", "surname", "suffix", "type", "fid", "citations", "review"];
function nameToGx(n) {
  const parts = [];
  if (n.given !== undefined) parts.push({ type: GX + "Given", value: n.given });
  if (n.surname !== undefined) parts.push({ type: GX + "Surname", value: n.surname });
  if (n.suffix !== undefined) parts.push({ type: GX + "Suffix", value: n.suffix });
  const full = [n.given, n.surname, n.suffix].filter(Boolean).join(" ");
  const g = { id: n.fid, nameForms: [{ fullText: full, parts }], [ft("nameType")]: n.type };
  const t = NAME_TYPES[String(n.type || "").toLowerCase()];
  if (t) g.type = GX + t;
  if (n.citations !== undefined) g.sources = citesToGx(n.citations);
  return clean({ ...g, ...reviewToGx(n.review), ...extra(n, NAME_KEYS) });
}
function nameFromGx(g) {
  const parts = (g.nameForms && g.nameForms[0] && g.nameForms[0].parts) || [];
  const part = (t) => { const p = parts.find((x) => x.type === GX + t); return p ? p.value : undefined; };
  const n = {};
  for (const [k, t] of [["given", "Given"], ["surname", "Surname"], ["suffix", "Suffix"]]) { const v = part(t); if (v !== undefined) n[k] = v; }
  if (!parts.length && g.nameForms && g.nameForms[0] && g.nameForms[0].fullText) { // another app's name with no parts
    const words = g.nameForms[0].fullText.trim().split(/\s+/);
    n.given = words.length > 1 ? words.slice(0, -1).join(" ") : words[0] || ""; n.surname = words.length > 1 ? words[words.length - 1] : ""; n.suffix = "";
  }
  if (g[ft("nameType")] !== undefined) n.type = g[ft("nameType")];
  else if (g.type) { const t = Object.entries(NAME_TYPES).find(([, v]) => GX + v === g.type); n.type = t ? t[0] : ""; }
  else if (!(ft("nameType") in g) && !g[ft("extra")]) n.type = "";
  if (g.id !== undefined) n.fid = g.id;
  if (g.sources) n.citations = citesFromGx(g.sources);
  const r = reviewFromGx(g);
  if (r) n.review = r;
  return { ...n, ...unextra(g) };
}

function clean(o) { return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)); }

// ---------------------------------------------------------------- persons
const PERSON_KEYS = ["id", "names", "sex", "famc", "fams", "events", "notes", "citations", "media"];
export function personToGx(p) {
  const g = { id: p.id, names: (p.names || []).map(nameToGx), facts: (p.events || []).map(eventToGx) };
  if (p.sex !== undefined) { g[ft("sex")] = p.sex; if (GENDER[p.sex]) g.gender = { type: GX + GENDER[p.sex] }; }
  if (p.notes !== undefined) g.notes = p.notes.map((t) => ({ text: t }));
  if (p.citations !== undefined) g.sources = citesToGx(p.citations);
  if (p.media !== undefined) g.media = p.media.map((m) => ({ description: `#${m}` }));
  // family membership lives in relationships; the ORDER of famc/fams is kept here so it rebuilds exactly
  if (p.famc !== undefined || p.fams !== undefined) g[ft("familyOrder")] = { famc: p.famc || [], fams: p.fams || [] };
  return { ...g, ...extra(p, PERSON_KEYS) };
}
export function personFromGx(g, links) {
  const p = { id: g.id, names: (g.names || []).map(nameFromGx) };
  if (g[ft("sex")] !== undefined) p.sex = g[ft("sex")];
  else { const t = g.gender && g.gender.type; p.sex = t === GX + "Male" ? "M" : t === GX + "Female" ? "F" : ""; } // another app's file
  const order = g[ft("familyOrder")];
  if (order || links) {
    const sort = (have, hint) => { const h = hint || []; return [...h.filter((x) => have.includes(x)), ...have.filter((x) => !h.includes(x))]; };
    p.famc = links ? sort(links.famc, order && order.famc) : order.famc;
    p.fams = links ? sort(links.fams, order && order.fams) : order.fams;
  }
  p.events = (g.facts || []).map(eventFromGx);
  if (g.notes !== undefined) p.notes = g.notes.map((n) => n.text);
  if (g.sources !== undefined) p.citations = citesFromGx(g.sources);
  if (g.media !== undefined) p.media = g.media.map((m) => String(m.description).replace(/^#/, ""));
  return { ...p, ...unextra(g) };
}

// ---------------------------------------------------------------- families ↔ relationships
const FAMILY_KEYS = ["id", "husband", "wife", "children", "events"];
/** One family → its relationships (Couple or FamilyGroup, then ParentChild per parent per child). */
export function familyToGx(f) {
  const out = [];
  const facts = (f.events || []).map(eventToGx);
  const base = { [ft("family")]: f.id, ...extra(f, FAMILY_KEYS) };
  if (f.husband && f.wife) {
    out.push({ id: f.id, type: GX + "Couple", person1: ref(f.husband), person2: ref(f.wife), facts, ...base });
  } else {
    // a Couple needs two people: keep the family's facts and known spouse on a group relationship
    const one = f.husband || f.wife;
    out.push(clean({ id: f.id, type: ft("FamilyGroup"), person1: one ? ref(one) : undefined, [ft("role")]: f.husband ? "husband" : f.wife ? "wife" : undefined,
      facts, [ft("children")]: !one ? (f.children || []) : undefined, ...base }));
  }
  (f.children || []).forEach((c, i) => {
    for (const [role, p] of [["husband", f.husband], ["wife", f.wife]]) {
      if (!p) continue;
      out.push({ id: `${f.id}~${role}~${c}`, type: GX + "ParentChild", person1: ref(p), person2: ref(c), [ft("family")]: f.id, [ft("parentRole")]: role, [ft("childIndex")]: i });
    }
  });
  return out;
}
/** Relationships (any order) → families keyed by id. `sexOf` helps place parents from other apps' files. */
export function familiesFromGx(relationships, sexOf = () => "") {
  relationships = groupForeign(relationships, sexOf);
  const fams = new Map();
  const get = (id) => { if (!fams.has(id)) fams.set(id, { id, husband: null, wife: null, children: [], events: [], _kids: new Map() }); return fams.get(id); };
  for (const r of relationships) {
    const fid = r[ft("family")] || r.id;
    const f = get(fid);
    if (r.type === GX + "Couple") {
      f.husband = unref(r.person1); f.wife = unref(r.person2); f.events = (r.facts || []).map(eventFromGx);
      Object.assign(f, unextra(r));
    } else if (r.type === ft("FamilyGroup")) {
      const p = unref(r.person1);
      if (p) f[r[ft("role")] || "husband"] = p;
      f.events = (r.facts || []).map(eventFromGx);
      for (const [i, c] of (r[ft("children")] || []).entries()) f._kids.set(c, i);
      Object.assign(f, unextra(r));
    } else if (r.type === GX + "ParentChild") {
      const role = r[ft("parentRole")], p = unref(r.person1), c = unref(r.person2);
      if (role) f[role] = f[role] || p;
      if (!f._kids.has(c)) f._kids.set(c, r[ft("childIndex")] ?? f._kids.size);
    }
  }
  const out = {};
  for (const [id, f] of fams) {
    f.children = [...f._kids.entries()].sort((a, b) => a[1] - b[1]).map(([c]) => c);
    delete f._kids;
    const { husband, wife, children, events, ...rest } = f;
    out[id] = { ...rest, husband, wife, children, events };
  }
  return out;
}
/**
 * Relationships from another app have no ft:family. Put each child's ParentChild links in the family of the Couple
 * formed by its parents; with one known parent, in that parent's own family group.
 */
function groupForeign(relationships, sexOf) {
  if (relationships.every((r) => r[ft("family")] || r.type !== GX + "ParentChild")) return relationships;
  const couples = relationships.filter((r) => r.type === GX + "Couple");
  const coupleOf = (a, b) => couples.find((c) => { const x = [unref(c.person1), unref(c.person2)]; return x.includes(a) && x.includes(b); });
  const parentsOf = new Map();
  for (const r of relationships) if (r.type === GX + "ParentChild" && !r[ft("family")]) {
    const c = unref(r.person2);
    if (!parentsOf.has(c)) parentsOf.set(c, []);
    parentsOf.get(c).push(r);
  }
  const out = relationships.filter((r) => !(r.type === GX + "ParentChild" && !r[ft("family")]));
  const order = new Map();
  for (const [c, links] of parentsOf) {
    const ps = links.map((l) => unref(l.person1));
    const cp = ps.length >= 2 ? coupleOf(ps[0], ps[1]) : null; // one known parent: their own family group
    const fam = cp ? cp.id : `${ps.join("+")}~family`;
    const i = order.get(fam) || 0; order.set(fam, i + 1);
    if (!cp && ps.length && !out.some((r) => r.id === fam)) {
      const one = ps.length === 1 ? ps[0] : null;
      out.push(one ? { id: fam, type: ft("FamilyGroup"), person1: ref(one), [ft("role")]: sexOf(one) === "F" ? "wife" : "husband", facts: [], [ft("family")]: fam }
        : { id: fam, type: GX + "Couple", person1: ref(ps[0]), person2: ref(ps[1]), facts: [], [ft("family")]: fam });
    }
    for (const l of links) {
      const p = unref(l.person1);
      const role = cp ? (unref(cp.person1) === p ? "husband" : "wife") : ps.length === 1 ? (sexOf(p) === "F" ? "wife" : "husband") : (ps[0] === p ? "husband" : "wife");
      out.push({ ...l, [ft("family")]: fam, [ft("parentRole")]: role, [ft("childIndex")]: i });
    }
  }
  return out;
}

export function familyFromGx(relationships) { return Object.values(familiesFromGx(relationships))[0] || null; }

// ---------------------------------------------------------------- sources and media (SourceDescription)
const SOURCE_KEYS = ["id", "title", "author", "publication", "url", "repository", "apid", "note", "type", "text"];
export function sourceToGx(s) {
  const g = { id: s.id, resourceType: GX + "Collection", [ft("kind")]: "source" };
  if (s.title !== undefined) g.titles = [{ value: s.title }];
  const cite = [s.author, s.title, s.publication].filter(Boolean).join(", ");
  if (cite) g.citations = [{ value: cite }];
  if (s.url !== undefined) g.about = s.url;
  for (const k of ["author", "publication", "repository", "apid", "note", "type", "text"]) if (s[k] !== undefined) g[ft(k)] = s[k];
  return { ...g, ...extra(s, SOURCE_KEYS) };
}
const MEDIA_KEYS = ["id", "file", "title", "form", "type", "kind", "date", "place"];
export function mediaToGx(m) {
  const g = { id: m.id, resourceType: GX + "DigitalArtifact", [ft("kind")]: "media" };
  if (m.file !== undefined) g.about = m.file;
  if (m.title !== undefined) g.titles = [{ value: m.title }];
  for (const k of ["form", "type", "kind", "date", "place"]) if (m[k] !== undefined) g[ft(`media/${k}`)] = m[k];
  return { ...g, ...extra(m, MEDIA_KEYS) };
}
export function sourceDescriptionFromGx(g) {
  if (g[ft("kind")] === "media") {
    const m = { id: g.id };
    if (g.about !== undefined) m.file = g.about;
    if (g.titles) m.title = g.titles[0].value;
    for (const k of ["form", "type", "kind", "date", "place"]) if (g[ft(`media/${k}`)] !== undefined) m[k] = g[ft(`media/${k}`)];
    return { kind: "media", value: { ...m, ...unextra(g) } };
  }
  const s = { id: g.id };
  if (g.titles) s.title = g.titles[0].value;
  if (g.about !== undefined) s.url = g.about;
  for (const k of ["author", "publication", "repository", "apid", "note", "type", "text"]) if (g[ft(k)] !== undefined) s[k] = g[ft(k)];
  return { kind: "source", value: { ...s, ...unextra(g) } };
}

// ---------------------------------------------------------------- whole trees
/** Working model {people, families, sources, media} → GEDCOM X {persons, relationships, sourceDescriptions}. */
export function toGx(raw) {
  return {
    persons: Object.values(raw.people || {}).map(personToGx),
    relationships: Object.values(raw.families || {}).flatMap(familyToGx),
    sourceDescriptions: [...Object.values(raw.sources || {}).map(sourceToGx), ...Object.values(raw.media || {}).map(mediaToGx)],
  };
}
/** GEDCOM X → working model. famc/fams come from the relationships, in their recorded order. */
export function fromGx(doc) {
  const sexes = new Map((doc.persons || []).map((g) => [g.id, g[ft("sex")] ?? (g.gender && g.gender.type === GX + "Female" ? "F" : g.gender && g.gender.type === GX + "Male" ? "M" : "")]));
  const families = familiesFromGx(doc.relationships || [], (id) => sexes.get(id) || "");
  const links = new Map();
  const link = (p) => { if (!links.has(p)) links.set(p, { famc: [], fams: [] }); return links.get(p); };
  for (const f of Object.values(families)) {
    for (const s of [f.husband, f.wife]) if (s) link(s).fams.push(f.id);
    for (const c of f.children) link(c).famc.push(f.id);
  }
  const people = {};
  for (const g of doc.persons || []) people[g.id] = personFromGx(g, links.get(g.id) || { famc: [], fams: [] });
  const sources = {}, media = {};
  for (const g of doc.sourceDescriptions || []) {
    const r = sourceDescriptionFromGx(g);
    (r.kind === "media" ? media : sources)[g.id] = r.value;
  }
  return { people, families, sources, media };
}

// ---------------------------------------------------------------- export: what a viewer can see, as a GEDCOM X document
// in an export, a fact matched to a place by its text points at that place too
const pickEvent = (e) => ({ ...pick(e, EVENT_KEYS), ...(e.placeKey && !e.place_ref ? { place_ref: e.placeKey } : {}) });

/** A place (as /api/tree shows it) → a GEDCOM X PlaceDescription: its names, type, point and enclosing place. */
export function placeToGx(key, pl) {
  const names = [{ value: pl.name }, ...(pl.names || []).map((n) => clean({ value: n.name, lang: n.lang }))];
  return clean({
    id: key, names, type: pl.type ? `${ft("place/")}${pl.type}` : undefined,
    latitude: pl.approx ? undefined : pl.lat, longitude: pl.approx ? undefined : pl.lng,
    jurisdiction: pl.parent ? { resource: `#${pl.parent}` } : undefined,
    [ft("shortName")]: pl.short, [ft("otherNames")]: pl.names && pl.names.length ? pl.names : undefined, [ft("note")]: pl.note,
  });
}
const pickName = (n) => pick(n, NAME_KEYS);
const local = (who) => String(who || "").split("@")[0];
const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", pdf: "application/pdf" };
const CONF = { high: "High", medium: "Medium", low: "Low" };

/**
 * A scoped, derived bundle (what /api/tree returns for the caller) → a GEDCOM X document. Derived fields are dropped;
 * people shown as names only stay names only; research findings become extracted personas (what a record says)
 * linked from the conclusion person as evidence, with an analysis Document. Reviewers' emails become their local part.
 */
export function exportDoc(b, { now = new Date(), title = "Family tree" } = {}) {
  const persons = [], relationships = [], sds = [], documents = [], agents = new Map();
  const agentRef = (who) => { const id = `agent-${local(who).replace(/[^\w.-]/g, "_")}`; if (!agents.has(id)) agents.set(id, { id, names: [{ value: local(who) }] }); return { resource: `#${id}` }; };
  const byId = {};
  for (const p of Object.values(b.people)) {
    let g;
    if (p.private) g = { id: p.id, private: true, names: (p.names || []).map((n) => nameToGx(pickName(n))) };
    else g = personToGx({ id: p.id, names: (p.names || []).map(pickName), sex: p.sex, famc: p.famc, fams: p.fams, events: (p.events || []).filter((e) => !e.misfiled).map(pickEvent), notes: p.notes || [], citations: p.citations || [], media: p.media || [] });
    g[ft("living")] = !!p.living;
    if (p.living) g.private = true;
    persons.push(g); byId[p.id] = g;
  }
  for (const f of Object.values(b.families)) relationships.push(...familyToGx({ id: f.id, husband: f.husband, wife: f.wife, children: f.children || [], events: (f.events || []).map(pickEvent) }));
  for (const s of Object.values(b.sources || {})) sds.push(sourceToGx(pick(s, SOURCE_KEYS)));
  for (const m of Object.values(b.media || {})) sds.push(mediaToGx(pick(m, MEDIA_KEYS)));
  // photos and documents attached in the app
  let n = 0;
  for (const [pid, list] of Object.entries((b.research && b.research.media) || {})) {
    if (!byId[pid]) continue;
    for (const m of list) {
      const id = `photo-${++n}`;
      sds.push(clean({ id, resourceType: GX + "DigitalArtifact", about: m.file, mediaType: MIME[String(m.file).split(".").pop().toLowerCase()],
        titles: m.caption ? [{ value: m.caption }] : undefined, [ft("mediaKind")]: m.type, [ft("date")]: m.date, [ft("place")]: m.place, [ft("note")]: m.note, [ft("transcript")]: m.transcript }));
      (byId[pid].media = byId[pid].media || []).push(clean({ description: `#${id}`, [ft("primary")]: m.portrait ? true : undefined }));
    }
    byId[pid].media && byId[pid].media.sort((x, y) => (y[ft("primary")] ? 1 : 0) - (x[ft("primary")] ? 1 : 0)); // main photo first
  }
  // research findings: what a record says (a persona) as evidence for the conclusion, with the analysis
  for (const f of (b.research && b.research.findings) || []) {
    const concl = f.person && byId[f.person];
    if (!concl || concl.private) continue;
    const srcRefs = (f.sources || []).map((src, i) => {
      const id = `finding-${f.id}-source-${i + 1}`;
      sds.push(clean({ id, resourceType: GX + "Record", titles: src.title ? [{ value: src.title }] : undefined, about: src.url, citations: [{ value: [src.title, src.note].filter(Boolean).join(". ") || "Source" }] }));
      return { description: `#${id}` };
    });
    const doc = clean({ id: `finding-${f.id}`, type: GX + "Analysis", text: [f.claim && `Tree: ${f.claim}`, f.finding].filter(Boolean).join("\n"),
      confidence: CONF[f.confidence] ? GX + CONF[f.confidence] : undefined, [ft("findingKind")]: f.kind, [ft("field")]: f.field, [ft("fact")]: f.fact,
      [ft("resolution")]: f.resolution ? { ...f.resolution, by: local(f.resolution.by) } : undefined });
    documents.push(doc);
    const persona = { id: `finding-${f.id}-persona`, extracted: true, names: (concl.names || []).slice(0, 1), sources: srcRefs, analysis: { resource: `#${doc.id}` } };
    persons.push(persona);
    (concl.evidence = concl.evidence || []).push({ resource: `#${persona.id}` });
  }
  // reviewers: agents, by local part only
  const walk = (x) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== "object") return;
    if (x.attribution && x.attribution.contributor && String(x.attribution.contributor.resource).startsWith("#agent:")) x.attribution.contributor = agentRef(x.attribution.contributor.resource.slice(7));
    if (x[ft("review")] && x[ft("review")].by) x[ft("review")] = { ...x[ft("review")], by: local(x[ft("review")].by) };
    Object.values(x).forEach(walk);
  };
  walk(persons);
  sds.unshift({ id: "export", resourceType: GX + "Collection", titles: [{ value: title }], citations: [{ value: `${title}, exported ${now.toISOString().slice(0, 10)}` }], [ft("exportedAt")]: now.toISOString() });
  // places the exported facts point at, with the places that enclose them
  const used = new Set(), places = [];
  const mark = (x) => { if (Array.isArray(x)) return x.forEach(mark); if (!x || typeof x !== "object") return; if (x.place && x.place.descriptionRef) used.add(x.place.descriptionRef.slice(1)); Object.values(x).forEach(mark); };
  mark(persons); mark(relationships);
  for (const k of [...used]) for (let at = (b.places || {})[k] && k; at && !places.some((p) => p.id === at); at = (b.places[at] || {}).parent) if (b.places[at]) places.push(placeToGx(at, b.places[at]));
  const known = new Set(places.map((p) => p.id));
  const unlink = (x) => { if (Array.isArray(x)) return x.forEach(unlink); if (!x || typeof x !== "object") return; if (x.place && x.place.descriptionRef && !known.has(x.place.descriptionRef.slice(1))) delete x.place.descriptionRef; Object.values(x).forEach(unlink); };
  unlink(persons); unlink(relationships);
  return { description: "#export", attribution: { modified: now.getTime(), changeMessage: "Export from the family-tree app" }, persons, relationships, sourceDescriptions: sds, places, agents: [...agents.values()], documents };
}
