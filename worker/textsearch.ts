// Search across everything a viewer can see: names (with spelling variants and sound-alikes), facts, places,
// notes, citations and transcriptions, stories, findings, to-dos and sources. It runs over a tree that has already
// been scoped to the viewer (worker/scope.js), so it can only ever find what that viewer may read. The site uses it on
// the tree it loaded; the MCP server uses it on the same scoped bundle. Pure functions, no I/O.

/** Lower case, accents and ligatures removed: "Erdős" → "erdos", "Straße" → "strasse". */
export function fold(s: unknown): string {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/ß/g, "ss").replace(/æ/g, "ae").replace(/œ/g, "oe").replace(/[øǿ]/g, "o").replace(/ł/g, "l").replace(/đ/g, "d").replace(/ı/g, "i");
}

const words = (s: string) => fold(s).match(/[a-z0-9]+/g) || [];

// ---------------------------------------------------------------- Daitch–Mokotoff Soundex
// The phonetic code made for Jewish and Central/Eastern European surnames: six digits, and some letters give two
// codes ("CH" may be K or TCH), so a name can have several. Table: [at the start, before a vowel, anywhere else];
// "" means not coded, "a|b" means both.
const DM: [string, string, string, string][] = ([
  ["SCHTSCH", "2", "4", "4"], ["SCHTSH", "2", "4", "4"], ["SCHTCH", "2", "4", "4"], ["SHTCH", "2", "4", "4"], ["SHTSH", "2", "4", "4"],
  ["STSCH", "2", "4", "4"], ["TTSCH", "4", "4", "4"], ["ZHDZH", "2", "4", "4"], ["SHCH", "2", "4", "4"], ["SCHT", "2", "43", "43"],
  ["SCHD", "2", "43", "43"], ["STCH", "2", "4", "4"], ["STRZ", "2", "4", "4"], ["STRS", "2", "4", "4"], ["STSH", "2", "4", "4"],
  ["SZCZ", "2", "4", "4"], ["SZCS", "2", "4", "4"], ["TTSZ", "4", "4", "4"], ["TSCH", "4", "4", "4"], ["ZDZH", "2", "4", "4"],
  ["ZSCH", "4", "4", "4"], ["CHS", "5", "54", "54"], ["CSZ", "4", "4", "4"], ["CZS", "4", "4", "4"], ["DRZ", "4", "4", "4"],
  ["DRS", "4", "4", "4"], ["DSH", "4", "4", "4"], ["DSZ", "4", "4", "4"], ["DZH", "4", "4", "4"], ["DZS", "4", "4", "4"],
  ["SCH", "4", "4", "4"], ["SHT", "2", "43", "43"], ["SZT", "2", "43", "43"], ["SHD", "2", "43", "43"], ["SZD", "2", "43", "43"],
  ["TCH", "4", "4", "4"], ["TRZ", "4", "4", "4"], ["TRS", "4", "4", "4"], ["TSH", "4", "4", "4"], ["TTS", "4", "4", "4"],
  ["TTZ", "4", "4", "4"], ["TZS", "4", "4", "4"], ["TSZ", "4", "4", "4"], ["ZDZ", "2", "4", "4"], ["ZHD", "2", "43", "43"],
  ["ZSH", "4", "4", "4"], ["AI", "0", "1", ""], ["AJ", "0", "1", ""], ["AY", "0", "1", ""], ["AU", "0", "7", ""],
  ["CH", "5|4", "5|4", "5|4"], ["CK", "5|45", "5|45", "5|45"], ["CZ", "4", "4", "4"], ["CS", "4", "4", "4"], ["DS", "4", "4", "4"],
  ["DZ", "4", "4", "4"], ["DT", "3", "3", "3"], ["EI", "0", "1", ""], ["EJ", "0", "1", ""], ["EY", "0", "1", ""],
  ["EU", "1", "1", ""], ["FB", "7", "7", "7"], ["IA", "1", "", ""], ["IE", "1", "", ""], ["IO", "1", "", ""],
  ["IU", "1", "", ""], ["KS", "5", "54", "54"], ["KH", "5", "5", "5"], ["MN", "66", "66", "66"], ["NM", "66", "66", "66"],
  ["OI", "0", "1", ""], ["OJ", "0", "1", ""], ["OY", "0", "1", ""], ["PF", "7", "7", "7"], ["PH", "7", "7", "7"],
  ["RZ", "94|4", "94|4", "94|4"], ["RS", "94|4", "94|4", "94|4"], ["SH", "4", "4", "4"], ["SC", "2", "4", "4"], ["ST", "2", "43", "43"],
  ["SZ", "4", "4", "4"], ["SD", "2", "43", "43"], ["TH", "3", "3", "3"], ["TS", "4", "4", "4"], ["TC", "4", "4", "4"],
  ["TZ", "4", "4", "4"], ["UI", "0", "1", ""], ["UJ", "0", "1", ""], ["UY", "0", "1", ""], ["UE", "0", "", ""],
  ["ZD", "2", "43", "43"], ["ZH", "4", "4", "4"], ["ZS", "4", "4", "4"],
  ["A", "0", "", ""], ["B", "7", "7", "7"], ["C", "5|4", "5|4", "5|4"], ["D", "3", "3", "3"], ["E", "0", "", ""],
  ["F", "7", "7", "7"], ["G", "5", "5", "5"], ["H", "5", "5", ""], ["I", "0", "", ""], ["J", "1|4", "|4", "|4"],
  ["K", "5", "5", "5"], ["L", "8", "8", "8"], ["M", "6", "6", "6"], ["N", "6", "6", "6"], ["O", "0", "", ""],
  ["P", "7", "7", "7"], ["Q", "5", "5", "5"], ["R", "9", "9", "9"], ["S", "4", "4", "4"], ["T", "3", "3", "3"],
  ["U", "0", "", ""], ["V", "7", "7", "7"], ["W", "7", "7", "7"], ["X", "5", "54", "54"], ["Y", "1", "", ""], ["Z", "4", "4", "4"],
] as [string, string, string, string][]).sort((a, b) => b[0].length - a[0].length);
const VOWEL = /[AEIOU]/;

/** Every Daitch–Mokotoff code for one word ("Peters" → ["739400", "734000"]). Empty for a word with no letters. */
export function dmSoundex(word: string): string[] {
  const s = fold(word).toUpperCase().replace(/[^A-Z]/g, "");
  if (!s) return [];
  let branches = [{ code: "", last: null as string | null }];
  for (let i = 0; i < s.length;) {
    const row = DM.find((r) => s.startsWith(r[0], i))!;
    const next = s[i + row[0].length];
    const cell = i === 0 ? row[1] : next && VOWEL.test(next) ? row[2] : row[3];
    // M and N side by side count twice ("MN" is its own row); everything else collapses a repeated code.
    const force = i > 0 && row[0].length === 1 && "MN".includes(row[0]) && "MN".includes(s[i - 1]) && s[i - 1] !== row[0];
    const out: typeof branches = [];
    for (const alt of cell.split("|")) for (const b of branches) {
      const append = b.last === null || !b.last.endsWith(alt) || force;
      out.push({ code: append ? b.code + alt : b.code, last: alt });
    }
    const seen = new Set<string>();
    branches = out.filter((b) => (seen.has(b.code + "/" + b.last) ? false : (seen.add(b.code + "/" + b.last), true)));
    i += row[0].length;
  }
  return [...new Set(branches.map((b) => (b.code + "000000").slice(0, 6)))];
}

/** Edit distance with transpositions, giving up once it passes `max`. */
export function distance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [], prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      best = Math.min(best, v);
    }
    if (best > max) return max + 1;
    prev2 = prev; prev = cur;
  }
  return prev[b.length];
}

/** How far apart two spellings may be and still count as close: none for short words, then 1, then 2. */
const closeLimit = (n: number) => (n >= 8 ? 2 : n >= 5 ? 1 : 0);

// ---------------------------------------------------------------- the index
export type Kind = "person" | "story" | "finding" | "todo" | "source";
export type How = "exact" | "sounds" | "close";
/** Field keys; the site and the MCP server label them. */
export type Field = "name" | "fact" | "note" | "citation" | "status" | "title" | "text" | "where" | "outcome";
type Doc = { kind: Kind; id: string; title: string; person?: string; private?: boolean; fields: { field: Field; text: string; name?: boolean }[] };
export type Index = { docs: Doc[]; names: Map<string, { codes: string[] }> };

const cleanStory = (s: string) => String(s || "").replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, "$1")
  .replace(/[#*_>`]+/g, " ");
const join = (...xs: unknown[]) => xs.filter((x) => x !== undefined && x !== null && x !== "").map(String).join(" · ");
const citeText = (c: any) => join(c && c.title, c && c.page, c && c.text, c && c.note);

/** Builds the search index for one scoped tree. Cheap enough to rebuild whenever the tree changes. */
export function buildIndex(tree: any): Index {
  const docs: Doc[] = [];
  const R = tree.research || {};
  const people = tree.people || {};
  const famEvents: Record<string, any[]> = {};
  for (const f of Object.values<any>(tree.families || {})) for (const pid of [f.husband, f.wife]) if (pid) (famEvents[pid] ||= []).push(...(f.events || []));
  for (const p of Object.values<any>(people)) {
    const fields: Doc["fields"] = [];
    const names = new Set([p.name, ...(p.names || []).map((n: any) => join(n.given, n.surname, n.suffix).replace(/ · /g, " "))].filter(Boolean));
    for (const n of names) fields.push({ field: "name", text: n, name: true });
    if (!p.private) {
      for (const e of [...(p.events || []), ...(famEvents[p.id] || [])]) {
        fields.push({ field: "fact", text: join(e.type, e.date, e.place, e.value) });
        if (e.note) fields.push({ field: "note", text: e.note });
        for (const c of e.citations || []) fields.push({ field: "citation", text: citeText(c) });
      }
      for (const n of p.notes || []) fields.push({ field: "note", text: n });
      for (const c of p.citations || []) fields.push({ field: "citation", text: citeText(c) });
      if (p.statusNote) fields.push({ field: "status", text: p.statusNote });
    }
    docs.push({ kind: "person", id: p.id, title: p.name, private: !!p.private, fields });
  }
  for (const s of R.stories || []) docs.push({ kind: "story", id: s.slug, title: s.title, fields: [
    { field: "title", text: s.title }, { field: "text", text: cleanStory(s.body) },
    ...(s.sources || []).map((c: any) => ({ field: "citation" as Field, text: citeText(c) }))] });
  (R.findings || []).forEach((f: any, i: number) => docs.push({ kind: "finding", id: String(f.id ?? i), person: f.person,
    title: f.claim || f.finding || "", fields: [
      { field: "text", text: join(f.claim, f.finding) },
      ...(f.resolution && f.resolution.note ? [{ field: "outcome" as Field, text: f.resolution.note }] : []),
      ...(f.sources || []).map((c: any) => ({ field: "citation" as Field, text: citeText(c) }))] }));
  (R.todo || []).forEach((t: any, i: number) => docs.push({ kind: "todo", id: String(t.id ?? i), person: t.person, title: t.task || "", fields: [
    { field: "text", text: t.task }, ...(t.where ? [{ field: "where" as Field, text: t.where }] : []),
    ...(t.outcome ? [{ field: "outcome" as Field, text: t.outcome }] : [])] }));
  for (const [id, s] of Object.entries<any>(tree.sources || {})) docs.push({ kind: "source", id, title: s.title || id, fields: [
    { field: "title", text: join(s.title, s.author, s.publication) }, ...(s.note || s.text ? [{ field: "text" as Field, text: join(s.text, s.note) }] : [])] });
  // Every distinct word in a name, with its phonetic codes, worked out once.
  const nameWords = new Map<string, { codes: string[] }>();
  for (const d of docs) for (const f of d.fields) if (f.name) for (const w of words(f.text)) if (!nameWords.has(w)) nameWords.set(w, { codes: dmSoundex(w) });
  return { docs, names: nameWords };
}

// ---------------------------------------------------------------- searching
export type Match = { field: Field; snippet: string; how: How; word?: string };
export type Hit = { kind: Kind; id: string; title: string; person?: string; private?: boolean; score: number; matches: Match[] };

/** Splits a query into terms; "quoted phrases" stay together. */
export function terms(q: string): string[] {
  const out: string[] = [];
  String(q || "").replace(/"([^"]+)"|(\S+)/g, (_, phrase, word) => { const t = fold(phrase || word).replace(/[^a-z0-9 ]+/g, " ").trim(); if (t) out.push(t); return ""; });
  return out;
}

/** Name words that sound like or are spelled close to a term, with how. Exact and prefix matches are found directly. */
function variants(ix: Index, term: string): Map<string, How> {
  const out = new Map<string, How>();
  if (term.length < 3 || term.includes(" ") || /\d/.test(term)) return out;
  const codes = new Set(dmSoundex(term)), lim = closeLimit(term.length);
  for (const [w, { codes: wc }] of ix.names) {
    if (w.startsWith(term)) continue;
    if (w.length >= 3 && wc.some((c) => codes.has(c))) out.set(w, "sounds");
    else if (lim && distance(term, w, lim) <= lim) out.set(w, "close");
  }
  return out;
}

function snippet(text: string, at: number, len: number, width = 140): string {
  if (text.length <= width) return text;
  const start = Math.max(0, Math.min(at - Math.floor((width - len) / 2), text.length - width));
  return (start > 0 ? "…" : "") + text.slice(start, start + width).trim() + (start + width < text.length ? "…" : "");
}

/** Where a folded term starts a word in folded text, or -1. Folding keeps one character per character for the
 *  scripts in a family tree, apart from ß/æ/œ, so the position is close enough to cut a snippet from the original. */
function findWord(folded: string, term: string): number {
  let i = folded.indexOf(term);
  while (i >= 0) {
    if (i === 0 || !/[a-z0-9]/.test(folded[i - 1])) return i;
    i = folded.indexOf(term, i + 1);
  }
  return -1;
}

const WEIGHT: Record<How, number> = { exact: 1, sounds: 0.6, close: 0.45 };
const FIELD_WEIGHT: Partial<Record<Field, number>> = { name: 10, title: 6, fact: 3, status: 2 };

export type SearchOptions = { kinds?: Kind[]; limit?: number; variants?: boolean; namesOnly?: boolean };

/** Every record matching all the query's terms, best first (exact matches before variants). A term matches a word that starts with it anywhere in
 *  the record, and in a name also a word that sounds like it or is spelled one or two letters differently. */
export function search(ix: Index, q: string, opts: SearchOptions = {}): Hit[] {
  const ts = terms(q);
  if (!ts.length) return [];
  const useVariants = opts.variants !== false;
  const vars = ts.map((t) => (useVariants ? variants(ix, t) : new Map<string, How>()));
  const hits: Hit[] = [];
  for (const d of ix.docs) {
    if (opts.kinds && !opts.kinds.includes(d.kind)) continue;
    const folded = d.fields.map((f) => fold(f.text));
    let score = 0;
    const matches: Match[] = [];
    let all = true;
    for (let k = 0; k < ts.length && all; k++) {
      let best: { m: Match; s: number } | null = null;
      d.fields.forEach((f, j) => {
        if (opts.namesOnly && !f.name) return;
        const fw = FIELD_WEIGHT[f.field] || 1;
        const at = findWord(folded[j], ts[k]);
        if (at >= 0) {
          const s = fw * WEIGHT.exact * (folded[j].length === ts[k].length ? 1.5 : 1);
          if (!best || s > best.s) best = { m: { field: f.field, snippet: snippet(f.text, at, ts[k].length), how: "exact" }, s };
        } else if (f.name && vars[k].size) {
          for (const w of f.text.match(/[\p{L}\p{N}]+/gu) || []) {
            const how = vars[k].get(fold(w));
            if (!how) continue;
            const s = fw * WEIGHT[how];
            if (!best || s > best.s) best = { m: { field: f.field, snippet: f.text, how, word: w }, s };
          }
        }
      });
      if (!best) all = false;
      else { score += (best as { s: number }).s; matches.push((best as { m: Match }).m); }
    }
    if (!all) continue;
    const seen = new Set<string>();
    hits.push({ kind: d.kind, id: d.id, title: d.title, person: d.person, private: d.private || undefined, score,
      matches: matches.filter((m) => (seen.has(m.field + m.snippet) ? false : (seen.add(m.field + m.snippet), true))) });
  }
  // Records where every word matched as written come first; a name that only sounds alike follows them all.
  const exact = (h: Hit) => (h.matches.every((m) => m.how === "exact") ? 1 : 0);
  hits.sort((a, b) => exact(b) - exact(a) || b.score - a.score || String(a.title).localeCompare(String(b.title)));
  return opts.limit ? hits.slice(0, opts.limit) : hits;
}
