/**
 * GEDCOM 5.5.1 export of a derived, scoped bundle (the shape /api/tree returns).
 *
 *   exportGedcom(bundle, { title, now })  -> string (UTF-8 text, CRLF line endings)
 *
 * `bundle` must already be scoped (worker/scope.js): this module never widens what it is given. People marked
 * `private: true` (living people reduced by a view) get only NAME, SEX and their family links. Nothing is
 * invented: a field that is empty in the bundle is left out of the file.
 *
 * Event types map back to their original tags with the EVENT_TAGS table of tools/gedcom_to_json.py; other
 * types become `EVEN` + `TYPE`. Long values wrap with CONC/CONT at 248 characters and '@' is written as '@@'.
 *
 * Plain ES2022, no dependencies, no I/O: runs in Node and in Cloudflare Workers.
 */

// tools/gedcom_to_json.py EVENT_TAGS (tag -> type name). The reverse map keeps the first tag per name, so
// "Military" exports as MILI rather than _MILT.
const EVENT_TAGS = {
  BIRT: "Birth", DEAT: "Death", BURI: "Burial", CHR: "Christening",
  BAPM: "Baptism", RESI: "Residence", OCCU: "Occupation",
  IMMI: "Immigration", EMIG: "Emigration", NATU: "Naturalization",
  CENS: "Census", MILI: "Military", EDUC: "Education",
  RELI: "Religion", GRAD: "Graduation", RETI: "Retirement",
  PROB: "Probate", WILL: "Will", EVEN: "Event", MARR: "Marriage",
  DIV: "Divorce", ENGA: "Engagement", _MILT: "Military",
  TITL: "Title", NATI: "Nationality", SSN: "Social Security",
  _DEG: "Degree", ARVL: "Arrival", DPRT: "Departure",
};
const TYPE_TO_TAG = {};
for (const [tag, name] of Object.entries(EVENT_TAGS)) if (!(name in TYPE_TO_TAG)) TYPE_TO_TAG[name] = tag;

// Event tags (as opposed to attributes) that take "Y" when the event is known but has no details.
const Y_EVENTS = new Set(["BIRT", "DEAT", "BURI", "CHR", "BAPM", "IMMI", "EMIG", "NATU", "CENS", "GRAD", "RETI",
  "PROB", "WILL", "MARR", "DIV", "ENGA", "ARVL", "DPRT"]);

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
export const MAX_VALUE = 248;

const str = (v) => (v === null || v === undefined ? "" : String(v));
const nonEmpty = (v) => str(v).trim() !== "";
const escapeAt = (s) => s.replace(/@/g, "@@");

/** Split one logical line (no newlines) into chunks whose escaped length is at most `max`, never
 *  breaking a code point and, where possible, never leaving a space at either side of a CONC boundary. */
export function splitForConc(text, max = MAX_VALUE) {
  const cps = Array.from(text);
  const w = (c) => (c === "@" ? 2 : 1); // '@' is written as '@@'
  const out = [];
  let i = 0;
  while (i < cps.length) {
    let len = 0, j = i;
    while (j < cps.length && len + w(cps[j]) <= max) { len += w(cps[j]); j++; }
    if (j < cps.length) {
      // back off so the boundary is not next to whitespace (many readers trim CONC values)
      let k = j;
      const ws = (c) => /\s/.test(c);
      while (k > i + 1 && (ws(cps[k]) || ws(cps[k - 1]))) k--;
      if (k > i + Math.floor(max / 2)) j = k;
    }
    out.push(cps.slice(i, j).join(""));
    i = j;
  }
  return out.length ? out : [""];
}

function gedDate(now) {
  const d = now instanceof Date ? now : new Date(now === undefined || now === null ? Date.now() : now);
  if (Number.isNaN(d.getTime())) throw new TypeError("exportGedcom: invalid `now`");
  const pad = (n) => String(n).padStart(2, "0");
  return {
    date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
  };
}

class Writer {
  constructor() { this.lines = []; }
  /** A line whose value is a pointer (or nothing): no escaping, no wrapping. */
  ptr(level, tag, pointer, xref) {
    this.lines.push([level, xref ? `@${xref}@` : null, tag, pointer ? `@${pointer}@` : ""].filter((x) => x !== null && x !== "").join(" "));
  }
  /** A raw line (value already safe). */
  raw(level, tag, value = "") {
    this.lines.push(value === "" ? `${level} ${tag}` : `${level} ${tag} ${value}`);
  }
  /** A text value: '@' escaped, newlines become CONT, long lines CONC. */
  text(level, tag, value) {
    const logical = str(value).replace(/\r\n?/g, "\n").split("\n");
    logical.forEach((ln, li) => {
      const chunks = splitForConc(ln);
      chunks.forEach((c, ci) => {
        const t = li === 0 && ci === 0 ? tag : ci === 0 ? "CONT" : "CONC";
        const lvl = li === 0 && ci === 0 ? level : level + 1;
        this.raw(lvl, t, escapeAt(c));
      });
    });
  }
  /** text() only when the value is non-empty. */
  opt(level, tag, value) { if (nonEmpty(value)) this.text(level, tag, value); }
  toString() { return this.lines.join("\r\n") + "\r\n"; }
}

/** Xref IDs: keep the bundle's IDs where they are valid GEDCOM xrefs and unique; otherwise allocate. */
function xrefAllocator() {
  const used = new Set(), map = new Map();
  let n = 0;
  const fresh = (prefix) => { let x; do x = `${prefix}${++n}`; while (used.has(x)); return x; };
  return {
    reserve(kind, id) {
      const key = `${kind}:${id}`;
      if (map.has(key)) return map.get(key);
      const s = str(id);
      const x = /^[A-Za-z0-9_]{1,20}$/.test(s) && !used.has(s) ? s : fresh("X");
      used.add(x); map.set(key, x);
      return x;
    },
    get(kind, id) { return map.get(`${kind}:${id}`); },
    fresh(prefix) { const x = fresh(prefix); used.add(x); return x; },
  };
}

export function exportGedcom(bundle, { title, now } = {}) {
  const P = bundle.people || {}, F = bundle.families || {}, S = bundle.sources || {}, M = bundle.media || {};
  const RM = (bundle.research && bundle.research.media) || {};
  const X = xrefAllocator();
  const g = new Writer();

  for (const id of Object.keys(P)) X.reserve("I", id);
  for (const id of Object.keys(F)) X.reserve("F", id);
  for (const id of Object.keys(S)) X.reserve("S", id);
  for (const id of Object.keys(M)) X.reserve("O", id);
  const SUBM = X.fresh("SUBM");

  // repositories named by sources (edit-ops source.upsert `repository`)
  const repos = new Map();
  for (const s of Object.values(S)) if (nonEmpty(s.repository) && !repos.has(s.repository)) repos.set(s.repository, X.fresh("R"));

  // photos attached in the app (research.media), visible people only, one OBJE record each
  const appMedia = []; // {xref, person, item}
  const personMedia = new Map();
  for (const [pid, items] of Object.entries(RM)) {
    if (!P[pid] || P[pid].private) continue;
    for (const item of items || []) {
      if (!item || !nonEmpty(item.file)) continue;
      const xref = X.fresh("M");
      appMedia.push({ xref, item });
      if (!personMedia.has(pid)) personMedia.set(pid, []);
      personMedia.get(pid).push(xref);
    }
  }

  const sourcePtr = (id) => (id !== undefined && id !== null && Object.prototype.hasOwnProperty.call(S, id) ? X.get("S", id) : null);

  const writeCitations = (level, cites) => {
    for (const c of cites || []) {
      if (!c) continue;
      const ptr = sourcePtr(c.source);
      if (ptr) g.ptr(level, "SOUR", ptr);
      else if (nonEmpty(c.source)) g.text(level, "SOUR", c.source); // source not in this bundle: unlinked citation
      else if (nonEmpty(c.title) || nonEmpty(c.url)) g.text(level, "SOUR", str(c.title || c.url)); // ad hoc citation
      else continue;
      g.opt(level + 1, "PAGE", c.page);
      if (nonEmpty(c.text) || nonEmpty(c.accessed)) {
        g.raw(level + 1, "DATA");
        g.opt(level + 2, "DATE", c.accessed);
        g.opt(level + 2, "TEXT", c.text);
      }
      g.opt(level + 1, "QUAY", c.quality); // GEDCOM certainty assessment, 0–3
      g.opt(level + 1, "NOTE", c.note);
      // evidence analysis (Evidence Explained): source / information / evidence
      g.opt(level + 1, "_SRCTYPE", c.source_type);
      g.opt(level + 1, "_INFO", c.information);
      g.opt(level + 1, "_EVID", c.evidence);
      g.opt(level + 1, "_APID", c.apid);
      g.opt(level + 1, "_LINK", c.url);
    }
  };

  const writeEvent = (level, e) => {
    if (!e) return;
    const type = str(e.type);
    let tag = TYPE_TO_TAG[type];
    let typeLine = nonEmpty(e.subtype) ? e.subtype : "";
    if (!tag) { tag = "EVEN"; typeLine = type; }
    const hasDetail = [typeLine, e.date, e.place, e.address, e.age, e.note].some(nonEmpty) || (e.citations || []).length > 0;
    if (nonEmpty(e.value)) g.text(level, tag, e.value);
    else g.raw(level, tag, !hasDetail && Y_EVENTS.has(tag) ? "Y" : "");
    g.opt(level + 1, "TYPE", typeLine);
    g.opt(level + 1, "DATE", e.date);
    g.opt(level + 1, "PLAC", e.place);
    g.opt(level + 1, "ADDR", e.address);
    g.opt(level + 1, "AGE", e.age);
    g.opt(level + 1, "NOTE", e.note);
    writeCitations(level + 1, e.citations);
    writeReview(level + 1, e.review);
  };
  // a reviewer's conclusion about a fact: a plain NOTE any program can read, plus a machine-readable _STAT
  const writeReview = (level, r) => {
    if (!r || !nonEmpty(r.status) || r.status === "unverified") return;
    g.text(level, "NOTE", `${r.status === "verified" ? "Verified" : "Disputed"} by ${str(r.by).split("@")[0]} on ${str(r.at).slice(0, 10)}${nonEmpty(r.note) ? `: ${r.note}` : ""}`);
    g.text(level, "_STAT", r.status.toUpperCase());
  };

  const writeName = (n) => {
    if (!n) return;
    const given = str(n.given).trim(), surname = str(n.surname).trim(), suffix = str(n.suffix).trim();
    if (!given && !surname && !suffix) return;
    const full = [given, `/${surname}/`, suffix].filter((x) => x !== "").join(" ");
    g.text(1, "NAME", full);
    g.opt(2, "GIVN", given);
    g.opt(2, "SURN", surname);
    g.opt(2, "NSFX", suffix);
    g.opt(2, "TYPE", n.type);
    writeCitations(2, n.citations);
    writeReview(2, n.review);
  };

  // ---- HEAD, SUBM
  const { date, time } = gedDate(now);
  g.raw(0, "HEAD");
  g.raw(1, "SOUR", "family-tree");
  g.raw(2, "NAME", "family-tree");
  g.raw(1, "DATE", date);
  g.raw(2, "TIME", time);
  g.ptr(1, "SUBM", SUBM);
  g.raw(1, "GEDC");
  g.raw(2, "VERS", "5.5.1");
  g.raw(2, "FORM", "LINEAGE-LINKED");
  g.raw(1, "CHAR", "UTF-8");
  g.opt(1, "NOTE", title);
  g.ptr(0, "SUBM", null, SUBM);
  g.text(1, "NAME", nonEmpty(title) ? title : "family-tree");

  // ---- INDI
  for (const [id, p] of Object.entries(P)) {
    g.ptr(0, "INDI", null, X.get("I", id));
    for (const n of p.names || []) writeName(n);
    if (nonEmpty(p.sex)) g.text(1, "SEX", p.sex);
    if (!p.private) for (const e of p.events || []) writeEvent(1, e);
    for (const f of p.famc || []) if (F[f]) g.ptr(1, "FAMC", X.get("F", f));
    for (const f of p.fams || []) if (F[f]) g.ptr(1, "FAMS", X.get("F", f));
    if (p.private) continue;
    for (const note of p.notes || []) g.opt(1, "NOTE", note);
    writeCitations(1, p.citations);
    for (const m of p.media || []) if (M[m]) g.ptr(1, "OBJE", X.get("O", m));
    for (const x of personMedia.get(id) || []) g.ptr(1, "OBJE", x);
  }

  // ---- FAM
  for (const [id, f] of Object.entries(F)) {
    g.ptr(0, "FAM", null, X.get("F", id));
    if (f.husband && P[f.husband]) g.ptr(1, "HUSB", X.get("I", f.husband));
    if (f.wife && P[f.wife]) g.ptr(1, "WIFE", X.get("I", f.wife));
    for (const c of f.children || []) if (P[c]) g.ptr(1, "CHIL", X.get("I", c));
    for (const e of f.events || []) writeEvent(1, e);
    for (const note of f.notes || []) g.opt(1, "NOTE", note);
    writeCitations(1, f.citations);
  }

  // ---- SOUR
  for (const [id, s] of Object.entries(S)) {
    g.ptr(0, "SOUR", null, X.get("S", id));
    g.opt(1, "TITL", s.title);
    g.opt(1, "AUTH", s.author);
    g.opt(1, "PUBL", s.publication);
    if (nonEmpty(s.repository)) g.ptr(1, "REPO", repos.get(s.repository));
    g.opt(1, "_APID", s.apid);
    g.opt(1, "_LINK", s.url);
  }
  for (const [name, xref] of repos) {
    g.ptr(0, "REPO", null, xref);
    g.text(1, "NAME", name);
  }

  // ---- OBJE (GEDCOM media records, then app-attached photos)
  const form = (file) => { const m = /\.([A-Za-z0-9]{1,5})$/.exec(str(file)); return m ? m[1].toLowerCase() : ""; };
  for (const [id, m] of Object.entries(M)) {
    g.ptr(0, "OBJE", null, X.get("O", id));
    g.text(1, "FILE", str(m.file));
    const f = form(m.file);
    if (f || nonEmpty(m.type) || nonEmpty(m.kind)) {
      g.raw(2, "FORM", escapeAt(f));
      g.opt(3, "TYPE", m.type);
      g.opt(3, "_MTYPE", m.kind);
    }
    g.opt(2, "TITL", m.title);
    g.opt(1, "DATE", m.date);
    g.opt(1, "PLAC", m.place);
  }
  for (const { xref, item } of appMedia) {
    g.ptr(0, "OBJE", null, xref);
    g.text(1, "FILE", str(item.file));
    const f = form(item.file);
    if (f || nonEmpty(item.type)) {
      g.raw(2, "FORM", escapeAt(f));
      g.opt(3, "TYPE", item.type); // photo, tombstone, newspaper, … (GEDCOM media types)
    }
    g.opt(2, "TITL", item.caption);
    if (item.portrait) g.raw(1, "_PRIM", "Y");
    g.opt(1, "DATE", item.date);
    g.opt(1, "NOTE", [item.place && `Place: ${item.place}`, item.note, item.transcript && `Transcript: ${item.transcript}`].filter(nonEmpty).join(". "));
    if (nonEmpty(item.source)) {
      const ptr = sourcePtr(item.source);
      if (ptr) g.ptr(1, "SOUR", ptr); else g.text(1, "SOUR", item.source);
    }
  }

  g.raw(0, "TRLR");
  return g.toString();
}
