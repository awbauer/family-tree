// The edit engine: apply a list of ops (docs/design/edit-ops.md) to the raw tree, in memory, atomically.
// Returns the touched entities with before/after snapshots, so the caller can write them with version checks
// and record an audit trail that can be reverted.
import { S as Strings } from "../strings/index.ts";

const M = Strings.api.ops; // `S` below is the working state

export class OpError extends Error {
  constructor(message, index) { super(index != null ? M.atOp(index + 1, message) : message); this.index = index; }
}

const clone = (x) => (x === undefined ? undefined : structuredClone(x));
const SEX = new Set(["M", "F", "U", ""]);
const EVENT_FIELDS = ["type", "date", "place", "note", "value", "age", "subtype", "address"];
const NAME_FIELDS = ["given", "surname", "suffix", "type"];
const REVIEW = new Set(["unverified", "verified", "disputed"]);
// Evidence analysis vocabulary (Mills, Evidence Explained; the Genealogical Proof Standard) and GEDCOM's QUAY.
export const CITATION_ENUMS = {
  source_type: ["original", "derivative", "authored"],          // what the source is
  information: ["primary", "secondary", "undetermined"],        // who supplied the information, and when
  evidence: ["direct", "indirect", "negative"],                  // how it answers the question
  quality: ["0", "1", "2", "3"],                                 // GEDCOM QUAY: 0 unreliable … 3 direct primary evidence
};
// GEDCOM 7 MEDI enumeration, lower-cased.
export const MEDIA_TYPES = ["audio", "book", "card", "electronic", "fiche", "film", "magazine", "manuscript", "map", "newspaper", "photo", "tombstone", "video", "other"];
const MEDIA_FIELDS = ["caption", "date", "place", "source", "note"];
// What kind of source a catalogued source record is (source.upsert `type`).
export const SOURCE_KINDS = ["original", "derivative", "tree", "book", "website"];
const SOURCE_FIELDS = ["title", "type", "author", "publication", "url", "repository", "apid", "note", "text"];

/**
 * Every place a source id is used: citations on people, their names and events, family events, the evidence of
 * fact reviews, and photos/documents (media_map `source`). Calls visit(kind, ownerId, obj) for each use (obj.source
 * === id) and returns the number of uses.
 */
export function forEachSourceUse(state, id, visit = () => {}) {
  let n = 0;
  const cites = (list, kind, owner) => { for (const c of list || []) if (c && c.source === id) { n++; visit(kind, owner, c); } };
  const fact = (f, kind, owner) => { cites(f.citations, kind, owner); if (f.review) cites(f.review.evidence, kind, owner); };
  for (const [pid, p] of Object.entries(state.people || {})) {
    if (!p) continue;
    cites(p.citations, "person", pid);
    for (const x of [...(p.names || []), ...(p.events || [])]) fact(x, "person", pid);
  }
  for (const [fid, f] of Object.entries(state.families || {})) for (const e of (f && f.events) || []) fact(e, "family", fid);
  for (const [pid, list] of Object.entries(state.media_map || {})) for (const m of list || []) if (m && m.source === id) { n++; visit("media_map", pid, m); }
  return n;
}

/** Give every event and name a stable fact id (used at import and for anything created without one). */
export function assignFids(entity) {
  let e = maxFid(entity.events, "e"), n = maxFid(entity.names, "n");
  for (const ev of entity.events || []) if (!ev.fid) ev.fid = `e${++e}`;
  for (const nm of entity.names || []) if (!nm.fid) nm.fid = `n${++n}`;
  return entity;
}
function maxFid(list, p) {
  let m = 0;
  for (const x of list || []) { const k = String(x.fid || "").match(new RegExp(`^${p}(\\d+)$`)); if (k) m = Math.max(m, +k[1]); }
  return m;
}

/**
 * state: {people, families, sources, media_map, aliases} (raw; not mutated).
 * Returns {state: newState, touched: [{type, id, before, after}], created: {tempId: realId}}.
 */
export function applyOps(state, ops, { actor = "unknown", now = new Date().toISOString(), newId } = {}) {
  if (!Array.isArray(ops) || !ops.length) throw new OpError(M.opsRequired);
  if (ops.length > 500) throw new OpError(M.tooMany);
  const S = { people: { ...state.people }, families: { ...state.families }, sources: { ...state.sources }, media_map: { ...(state.media_map || {}) }, aliases: { ...(state.aliases || {}) } };
  const before = new Map(); // key -> snapshot before first touch
  const key = (t, id) => `${t}:${id}`;
  const coll = { person: "people", family: "families", source: "sources", media_map: "media_map" };
  const touch = (t, id) => {
    const k = key(t, id), c = S[coll[t]];
    if (!before.has(k)) before.set(k, { type: t, id, before: clone(c[id]) });
    if (c[id] !== undefined) c[id] = clone(c[id]); // copy-on-write
    return c[id];
  };
  const counter = { n: 0 };
  const mkId = (prefix, c) => {
    if (newId) return newId(prefix);
    let id;
    do { id = `N${prefix}${Date.now().toString(36)}${(counter.n++).toString(36)}`; } while (c[id]);
    return id;
  };
  const alias = (id) => S.aliases[id] || id;
  const P = (id, i) => { const x = S.people[alias(id)]; if (!x) throw new OpError(M.noPerson(id), i); return alias(id); };
  const F = (id, i) => { if (!S.families[id]) throw new OpError(M.noFamily(id), i); return id; };
  const entityOf = (o, i) => {
    if (o.entity === "person") return ["person", P(o.id, i)];
    if (o.entity === "family") return ["family", F(o.id, i)];
    throw new OpError(M.entityInvalid, i);
  };
  const findFact = (list, fid, i, what = "fact") => {
    const idx = (list || []).findIndex((x) => x.fid === fid);
    if (idx < 0) throw new OpError(M.noFact(what, fid), i);
    return idx;
  };
  const cleanEvent = (ev, i) => {
    if (!ev || typeof ev !== "object" || !String(ev.type || "").trim()) throw new OpError(M.eventNeedsType, i);
    const out = {};
    for (const k of EVENT_FIELDS) if (ev[k] != null && ev[k] !== "") out[k] = String(ev[k]).slice(0, 2000);
    if (ev.citations) out.citations = ev.citations.map((c) => cleanCitation(c, i));
    return out;
  };
  const cleanCitation = (c, i) => {
    if (!c || (!c.source && !c.url && !c.note && !c.title)) throw new OpError(M.citationEmpty, i);
    if (c.source && !S.sources[c.source]) throw new OpError(M.noSource(c.source), i);
    if (c.url && !/^https?:\/\//i.test(String(c.url))) throw new OpError(M.citationUrl, i);
    const out = {};
    // page = GEDCOM PAGE ("where within the source"); text = a transcription of the record; accessed = date viewed
    for (const k of ["source", "title", "page", "url", "note", "text", "apid", "repository", "accessed"]) if (c[k]) out[k] = String(c[k]).slice(0, 4000);
    for (const [k, allowed] of Object.entries(CITATION_ENUMS)) {
      if (c[k] == null || c[k] === "") continue;
      const v = String(c[k]);
      if (!allowed.includes(v)) throw new OpError(M.citationEnum(k, allowed), i);
      out[k] = v;
    }
    return out;
  };
  const cleanMedia = (o, m, i) => {
    for (const k of MEDIA_FIELDS) if (k in o) { if (o[k] == null || o[k] === "") delete m[k]; else m[k] = String(o[k]).slice(0, 1000); }
    if ("type" in o && o.type != null && o.type !== "") {
      if (!MEDIA_TYPES.includes(o.type)) throw new OpError(M.mediaType(MEDIA_TYPES), i);
      m.type = o.type;
    }
    return m;
  };
  /** A fact is an event (e1, e2, …) or, on a person, a name (n1, n2, …). */
  const factList = (x, fid) => (String(fid).startsWith("n") && x.names ? x.names : x.events);
  const cleanName = (n, i) => {
    if (!n || (!String(n.given || "").trim() && !String(n.surname || "").trim())) throw new OpError(M.nameEmpty, i);
    const out = {};
    for (const k of NAME_FIELDS) out[k] = String(n[k] || "").trim().slice(0, 200);
    return out;
  };
  const created = {};
  const ref = (id) => (id && created[id]) || id; // allow later ops to refer to "$new1"-style temp ids

  ops.forEach((raw, i) => {
    const o = JSON.parse(JSON.stringify(raw, (k, v) => (typeof v === "string" && v.startsWith("$") && created[v] ? created[v] : v)));
    switch (o.op) {
      case "person.create": {
        const id = o.id && !o.id.startsWith("$") ? o.id : mkId("I", S.people);
        if (S.people[id]) throw new OpError(M.personExists(id), i);
        if (o.id && o.id.startsWith("$")) created[o.id] = id;
        const names = (o.names || []).map((n) => cleanName(n, i));
        if (!names.length) throw new OpError(M.personNeedsName, i);
        if (o.sex != null && !SEX.has(o.sex)) throw new OpError(M.sexInvalid, i);
        touch("person", id);
        S.people[id] = assignFids({ id, names, sex: o.sex || "", famc: [], fams: [], events: (o.events || []).map((e) => cleanEvent(e, i)), notes: [], citations: [], media: [], created: { by: actor, at: now } });
        break;
      }
      case "person.update": {
        const id = P(o.id, i), p = touch("person", id);
        const set = o.set || {};
        if ("sex" in set) { if (!SEX.has(set.sex)) throw new OpError(M.sexInvalid, i); p.sex = set.sex; }
        if ("notes" in set) p.notes = [].concat(set.notes || []).map((x) => String(x).slice(0, 8000));
        break;
      }
      case "person.delete": {
        const id = P(o.id, i), p = S.people[id];
        if ((p.famc || []).length || (p.fams || []).length) throw new OpError(M.unlinkFirst, i);
        touch("person", id);
        delete S.people[id];
        if (S.media_map[id]) { touch("media_map", id); delete S.media_map[id]; }
        break;
      }
      case "person.merge": {
        const keep = P(o.keep, i), drop = P(o.drop, i);
        if (keep === drop) throw new OpError(M.samePerson, i);
        const k = touch("person", keep), d = touch("person", drop);
        const have = new Set(k.names.map((n) => `${n.given}|${n.surname}`));
        for (const n of d.names) if (!have.has(`${n.given}|${n.surname}`)) k.names.push({ ...n, fid: undefined, type: n.type || "alternate" });
        const ek = (e) => `${e.type}|${(e.date || "").toLowerCase()}|${(e.place || "").toLowerCase()}|${e.value || ""}`;
        const he = new Set(k.events.map(ek));
        for (const e of d.events) if (!he.has(ek(e))) k.events.push({ ...e, fid: undefined });
        for (const f of ["citations", "media", "notes"]) k[f] = (k[f] || []).concat((d[f] || []).filter((x) => !JSON.stringify(k[f] || []).includes(JSON.stringify(x))));
        assignFids(k);
        for (const fid of d.famc || []) { const f = touch("family", fid); f.children = [...new Set(f.children.map((c) => (c === drop ? keep : c)))]; if (!k.famc.includes(fid)) k.famc.push(fid); }
        for (const fid of d.fams || []) { const f = touch("family", fid); if (f.husband === drop) f.husband = keep; if (f.wife === drop) f.wife = keep; if (!k.fams.includes(fid)) k.fams.push(fid); }
        k.mergedFrom = (k.mergedFrom || []).concat(drop);
        delete S.people[drop];
        S.aliases[drop] = keep;
        for (const [a, b] of Object.entries(S.aliases)) if (b === drop) S.aliases[a] = keep;
        before.set("aliases:*", before.get("aliases:*") || { type: "aliases", id: "*", before: clone(state.aliases || {}) });
        if (S.media_map[drop]) {
          touch("media_map", drop); touch("media_map", keep);
          S.media_map[keep] = (S.media_map[keep] || []).concat(S.media_map[drop]);
          delete S.media_map[drop];
        }
        break;
      }
      case "name.add": { const id = P(o.person, i), p = touch("person", id); p.names.push(cleanName(o.name, i)); assignFids(p); break; }
      case "name.update": {
        const id = P(o.person, i), p = touch("person", id), j = findFact(p.names, o.fid, i, "name");
        p.names[j] = { ...p.names[j], ...cleanName({ ...p.names[j], ...(o.set || {}) }, i), fid: o.fid };
        break;
      }
      case "name.remove": {
        const id = P(o.person, i), p = touch("person", id), j = findFact(p.names, o.fid, i, "name");
        if (p.names.length < 2) throw new OpError(M.keepOneName, i);
        p.names.splice(j, 1);
        break;
      }
      case "event.add": { const [t, id] = entityOf(o, i), x = touch(t, id); x.events = x.events || []; x.events.push(cleanEvent(o.event, i)); assignFids(x); break; }
      case "event.update": {
        const [t, id] = entityOf(o, i), x = touch(t, id), j = findFact(x.events, o.fid, i, "event");
        const merged = cleanEvent({ ...x.events[j], ...(o.set || {}) }, i);
        x.events[j] = { ...merged, fid: o.fid, citations: x.events[j].citations, review: x.events[j].review };
        if (!x.events[j].citations) delete x.events[j].citations;
        if (!x.events[j].review) delete x.events[j].review;
        break;
      }
      case "event.remove": { const [t, id] = entityOf(o, i), x = touch(t, id); x.events.splice(findFact(x.events, o.fid, i, "event"), 1); break; }
      case "fact.review": {
        // A reviewer's conclusion about one fact, with the evidence it rests on (GPS: cite, analyse, resolve, conclude).
        // `evidence` lists citations already on the fact ({index}) and/or new ones, which are also added to the fact.
        const [t, id] = entityOf(o, i), x = touch(t, id), list = factList(x, o.fid), j = findFact(list, o.fid, i);
        if (!REVIEW.has(o.status)) throw new OpError(M.reviewStatus, i);
        const fact = list[j];
        const evidence = [];
        for (const ev of (o.evidence || []).slice(0, 20)) {
          if (ev && Number.isInteger(ev.index)) {
            const c = (fact.citations || [])[ev.index];
            if (!c) throw new OpError(M.noCitation(ev.index, o.fid), i);
            evidence.push(c);
          } else {
            const c = cleanCitation(ev, i);
            (fact.citations = fact.citations || []).push(c);
            evidence.push(c);
          }
        }
        if (o.status === "verified" && !evidence.length && !(fact.citations || []).length) throw new OpError(M.verifyNeedsSource, i);
        fact.review = { status: o.status, by: actor, at: now, note: String(o.note || "").slice(0, 2000) };
        if (evidence.length) fact.review.evidence = evidence;
        if (o.finding != null) fact.review.finding = o.finding;
        break;
      }
      case "citation.add": {
        const [t, id] = entityOf(o, i), x = touch(t, id), c = cleanCitation(o.citation, i);
        if (o.fid) { const list = factList(x, o.fid), j = findFact(list, o.fid, i); (list[j].citations = list[j].citations || []).push(c); }
        else (x.citations = x.citations || []).push(c);
        break;
      }
      case "citation.remove": {
        const [t, id] = entityOf(o, i), x = touch(t, id);
        const list = o.fid ? factList(x, o.fid)[findFact(factList(x, o.fid), o.fid, i)].citations : x.citations;
        if (!list || !(o.index >= 0 && o.index < list.length)) throw new OpError(M.noCitationAtIndex, i);
        list.splice(o.index, 1);
        break;
      }
      case "family.create": {
        const id = o.id && !o.id.startsWith("$") ? o.id : mkId("F", S.families);
        if (S.families[id]) throw new OpError(M.familyExists(id), i);
        if (o.id && o.id.startsWith("$")) created[o.id] = id;
        const h = o.husband ? P(ref(o.husband), i) : null, w = o.wife ? P(ref(o.wife), i) : null;
        const kids = (o.children || []).map((c) => P(ref(c), i));
        if (!h && !w && kids.length < 1) throw new OpError(M.familyNeedsMember, i);
        touch("family", id);
        S.families[id] = assignFids({ id, husband: h, wife: w, children: kids, events: (o.events || []).map((e) => cleanEvent(e, i)) });
        for (const s of [h, w].filter(Boolean)) { const p = touch("person", s); if (!p.fams.includes(id)) p.fams.push(id); }
        for (const c of kids) { const p = touch("person", c); if (!p.famc.includes(id)) p.famc.push(id); }
        break;
      }
      case "family.set_spouse": {
        const fid = F(o.family, i), f = touch("family", fid);
        if (!["husband", "wife"].includes(o.role)) throw new OpError(M.roleInvalid, i);
        const old = f[o.role], nu = o.person ? P(ref(o.person), i) : null;
        if (old && old !== f[o.role === "husband" ? "wife" : "husband"]) { const p = touch("person", old); p.fams = p.fams.filter((x) => x !== fid); }
        f[o.role] = nu;
        if (nu) { const p = touch("person", nu); if (!p.fams.includes(fid)) p.fams.push(fid); }
        break;
      }
      case "family.swap_spouses": { const fid = F(o.family, i), f = touch("family", fid); [f.husband, f.wife] = [f.wife, f.husband]; break; }
      case "family.add_child": {
        const fid = F(o.family, i), pid = P(ref(o.person), i), f = touch("family", fid), p = touch("person", pid);
        if (!f.children.includes(pid)) f.children.push(pid);
        if (!p.famc.includes(fid)) p.famc.push(fid);
        break;
      }
      case "family.remove_child": {
        const fid = F(o.family, i), pid = P(o.person, i), f = touch("family", fid), p = touch("person", pid);
        f.children = f.children.filter((c) => c !== pid);
        p.famc = p.famc.filter((x) => x !== fid);
        break;
      }
      case "family.delete": {
        const fid = F(o.family, i), f = S.families[fid];
        for (const pid of [f.husband, f.wife, ...f.children].filter(Boolean)) {
          if (!S.people[pid]) continue;
          const p = touch("person", pid);
          p.famc = p.famc.filter((x) => x !== fid); p.fams = p.fams.filter((x) => x !== fid);
        }
        touch("family", fid); delete S.families[fid];
        break;
      }
      case "family.merge": {
        const keep = F(o.keep, i), drop = F(o.drop, i);
        if (keep === drop) throw new OpError(M.sameFamily, i);
        const fk = touch("family", keep), fd = touch("family", drop);
        for (const r of ["husband", "wife"]) {
          if (fk[r] && fd[r] && fk[r] !== fd[r]) throw new OpError(M.spousesDiffer(r), i);
          fk[r] = fk[r] || fd[r];
        }
        fk.children = [...new Set([...fk.children, ...fd.children])];
        const ek = (e) => `${e.type}|${(e.date || "").toLowerCase()}|${(e.place || "").toLowerCase()}`;
        const he = new Set(fk.events.map(ek));
        for (const e of fd.events) if (!he.has(ek(e))) fk.events.push({ ...e, fid: undefined });
        assignFids(fk);
        for (const pid of [fd.husband, fd.wife, ...fd.children].filter(Boolean)) {
          const p = touch("person", pid);
          p.famc = [...new Set(p.famc.map((x) => (x === drop ? keep : x)))];
          p.fams = [...new Set(p.fams.map((x) => (x === drop ? keep : x)))];
        }
        delete S.families[drop];
        break;
      }
      case "source.upsert": {
        const id = o.id || mkId("S", S.sources);
        if (!o.data || typeof o.data !== "object") throw new OpError(M.sourceNeedsData, i);
        const d = { ...(S.sources[id] || {}) };
        for (const k of SOURCE_FIELDS) {
          if (!(k in o.data)) continue;
          const v = o.data[k] == null ? "" : String(o.data[k]).trim();
          if (v === "") delete d[k]; // an empty value removes the field
          else d[k] = v.slice(0, k === "text" ? 20000 : 2000);
        }
        if (!d.title) throw new OpError(M.sourceNeedsTitle, i);
        if (d.type && !SOURCE_KINDS.includes(d.type)) throw new OpError(M.sourceType(SOURCE_KINDS), i);
        if (d.url && !/^https?:\/\//i.test(d.url)) throw new OpError(M.sourceUrl, i);
        touch("source", id);
        S.sources[id] = { ...d, id };
        break;
      }
      case "source.merge": {
        // re-point every use of `drop` to `keep`, fill keep's empty fields from drop, then remove drop
        const { keep, drop } = o;
        if (!S.sources[keep]) throw new OpError(M.noSource(keep), i);
        if (!S.sources[drop]) throw new OpError(M.noSource(drop), i);
        if (keep === drop) throw new OpError(M.sameSource, i);
        const owners = [];
        forEachSourceUse(S, drop, (kind, owner) => owners.push([kind, owner]));
        for (const [kind, owner] of owners) touch(kind, owner); // copy-on-write, then change the copies
        forEachSourceUse(S, drop, (_kind, _owner, c) => { c.source = keep; });
        const k = touch("source", keep), d = S.sources[drop];
        for (const f of SOURCE_FIELDS) if (!k[f] && d[f]) k[f] = d[f];
        touch("source", drop);
        delete S.sources[drop];
        break;
      }
      case "source.delete": {
        if (!S.sources[o.id]) throw new OpError(M.noSource(o.id), i);
        const n = forEachSourceUse(S, o.id);
        if (n) throw new OpError(M.sourceStillCited(o.id, n), i);
        touch("source", o.id);
        delete S.sources[o.id];
        break;
      }
      case "media.attach": {
        const pid = P(o.person, i);
        if (!o.file || o.file.startsWith("/") || o.file.includes("..")) throw new OpError(M.fileKey, i);
        touch("media_map", pid);
        const list = S.media_map[pid] = [...(S.media_map[pid] || [])];
        if (!list.some((m) => m.file === o.file)) {
          const m = cleanMedia(o, { file: o.file }, i);
          if (o.portrait) { for (const x of list) delete x.portrait; m.portrait = true; }
          list.push(m);
        }
        break;
      }
      case "media.update": {
        const pid = P(o.person, i);
        touch("media_map", pid);
        const list = S.media_map[pid] = (S.media_map[pid] || []).map((m) => ({ ...m }));
        const m = list.find((x) => x.file === o.file);
        if (!m) throw new OpError(M.noMedia(o.file), i);
        cleanMedia(o.set || {}, m, i);
        break;
      }
      case "media.set_primary": {
        // the person's main photo (their icon); exported as GEDCOM _PRIM Y
        const pid = P(o.person, i);
        touch("media_map", pid);
        const list = S.media_map[pid] = (S.media_map[pid] || []).map((m) => ({ ...m }));
        if (!list.some((x) => x.file === o.file)) throw new OpError(M.noMedia(o.file), i);
        for (const m of list) { if (m.file === o.file) m.portrait = true; else delete m.portrait; }
        break;
      }
      case "media.detach": {
        const pid = P(o.person, i);
        touch("media_map", pid);
        S.media_map[pid] = (S.media_map[pid] || []).filter((m) => m.file !== o.file);
        if (!S.media_map[pid].length) delete S.media_map[pid];
        break;
      }
      default:
        throw new OpError(M.unknownOp(o.op), i);
    }
  });

  // integrity: every link points at something that exists, both directions agree
  for (const [fid, f] of Object.entries(S.families)) {
    for (const pid of [f.husband, f.wife, ...f.children].filter(Boolean)) if (!S.people[pid]) throw new OpError(M.missingMember(fid, pid));
  }
  const touched = [];
  for (const [k, b] of before) {
    const c = b.type === "aliases" ? null : S[coll[b.type]];
    touched.push({ type: b.type, id: b.id, before: b.before, after: b.type === "aliases" ? clone(S.aliases) : clone(c[b.id]) });
  }
  return { state: S, touched: touched.filter((t) => JSON.stringify(t.before) !== JSON.stringify(t.after)), created };
}

/** Every person/family id an op list reads or writes (for scope checks). */
export function referencedIds(ops) {
  const people = new Set(), families = new Set();
  for (const o of ops || []) {
    if (String(o.op || "").startsWith("source.")) continue; // source ids, not people: see sourceIds
    for (const k of ["id", "person", "keep", "drop", "husband", "wife"]) {
      const v = o[k];
      if (typeof v !== "string" || v.startsWith("$")) continue;
      if (o.op && o.op.startsWith("family.") && (k === "keep" || k === "drop")) families.add(v);
      else if (k === "id" && (o.entity === "family" || o.op === "family.create" || o.op === "source.upsert")) { if (o.entity === "family") families.add(v); }
      else if (k !== "id" || o.entity === "person" || o.op.startsWith("person.")) people.add(v);
    }
    if (o.family) families.add(o.family);
    for (const c of o.children || []) if (!String(c).startsWith("$")) people.add(c);
    if (o.op === "person.create" && o.id) people.delete(o.id);
  }
  return { people, families };
}

/** The existing source ids an op list changes or removes (source.upsert with an id, source.merge, source.delete). */
export function sourceIds(ops) {
  const out = new Set();
  for (const o of ops || []) {
    if (o.op === "source.upsert" && o.id) out.add(o.id);
    if (o.op === "source.merge") for (const v of [o.keep, o.drop]) if (v) out.add(v);
    if (o.op === "source.delete" && o.id) out.add(o.id);
  }
  return out;
}
