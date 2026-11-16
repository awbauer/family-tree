/**
 * Derivation of the site bundle from stored raw data: a port of tools/build.py.
 *
 *   derive({ raw, research, places, aliases }, { today: "YYYY-MM-DD" })  -> family.json bundle
 *
 * Input is what `python3 tools/build.py --raw-out PATH` writes: `raw` is the gedcom_to_json.parse()
 * shape with grafts and edits applied, `research` is research.json after the edit/alias remaps,
 * `places` is places.json, `aliases` the {dropped: kept} map from merges (optional).
 *
 * Parity with build.py is checked by tests/derive.test.mjs. Python semantics that matter and are
 * reproduced here: str.strip()/split() whitespace, re's Unicode \d \w \s \b and `$`, dict.get()
 * defaults, truthiness of empty containers, code-point string ordering, first-wins max().
 *
 * Plain ES2022, no dependencies, no I/O: runs in Node and in Cloudflare Workers.
 */

// ---------- Python compatibility helpers ----------

const PY_WS = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WORD = "[\\p{L}\\p{N}_]";
const RX_STRIP = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "gu");
const RX_WS_RUN = new RegExp(`[${PY_WS}]+`, "u");

const pyStrip = (s) => s.replace(RX_STRIP, "");
const pySplit = (s) => pyStrip(s).split(RX_WS_RUN).filter((t) => t !== "");
const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
const get = (o, k, d = null) => (has(o, k) ? o[k] : d);
/** Python truthiness (empty list/dict are false). */
function truthy(v) {
  if (v === null || v === undefined || v === false || v === 0 || v === "" || Number.isNaN(v)) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}
/** str(x) for values that end up in messages. */
const pyStr = (v) => (v === null || v === undefined ? "None" : v === true ? "True" : v === false ? "False" : String(v));
/** Python str ordering (by code point, not UTF-16 unit). */
function cmpStr(a, b) {
  if (a === b) return 0;
  const A = [...a], B = [...b];
  for (let i = 0; i < Math.min(A.length, B.length); i++) {
    const x = A[i].codePointAt(0), y = B[i].codePointAt(0);
    if (x !== y) return x - y;
  }
  return A.length - B.length;
}
/** int() of a string of Unicode decimal digits (Python's \d matches all of \p{Nd}). */
const RX_ND = /\p{Nd}/u;
function digitValue(ch) {
  let cp = ch.codePointAt(0), n = 0;
  while (cp - n - 1 >= 0 && RX_ND.test(String.fromCodePoint(cp - n - 1))) n++;
  return n % 10; // Nd code points come in aligned runs starting at the zero digit
}
function pyInt(s) {
  let v = 0;
  for (const ch of s) v = v * 10 + (ch >= "0" && ch <= "9" ? ch.charCodeAt(0) - 48 : digitValue(ch));
  return v;
}

/**
 * Translate a Python `re` pattern (as used in places.json / place_rules) to a JS source for flags "iu".
 * Covers Unicode \d \w \s \b \B, `$` (end or before a final newline), `.` (anything but \n), \A \Z,
 * named groups, inline comments and Python's lenient literal `{`, `}` and `]` and identity escapes.
 */
export function pyRegex(src) {
  const SYNTAX = "^$\\.*+?()[]{}|/";
  const NWORD = `(?<!${WORD})`, AWORD = `(?<=${WORD})`;
  let out = "", i = 0;
  const n = src.length;
  const escOutside = (c) => {
    switch (c) {
      case "b": return `(?:${AWORD}(?!${WORD})|${NWORD}(?=${WORD}))`;
      case "B": return `(?:${AWORD}(?=${WORD})|${NWORD}(?!${WORD}))`;
      case "d": return "\\p{Nd}";
      case "D": return "\\P{Nd}";
      case "w": return WORD;
      case "W": return "[^\\p{L}\\p{N}_]";
      case "s": return `[${PY_WS}]`;
      case "S": return `[^${PY_WS}]`;
      case "A": return "(?<![\\s\\S])";
      case "Z": return "(?![\\s\\S])";
      default: return null;
    }
  };
  const literalEsc = (c, inClass) => {
    if (/[A-Za-z0-9]/.test(c)) return "\\" + c; // \n \t \x.. \u.... backrefs: same meaning in JS
    if (SYNTAX.includes(c) || (inClass && c === "-")) return "\\" + c;
    return c;
  };
  while (i < n) {
    const c = src[i];
    if (c === "\\") {
      const d = src[i + 1];
      if (d === undefined) throw new SyntaxError("pattern ends with a backslash");
      if (d === "U") { out += `\\u{${src.slice(i + 2, i + 10).replace(/^0+(?=.)/, "")}}`; i += 10; continue; }
      if (d === "x") { out += "\\x" + src.slice(i + 2, i + 4); i += 4; continue; }
      if (d === "u") { out += "\\u" + src.slice(i + 2, i + 6); i += 6; continue; }
      out += escOutside(d) ?? literalEsc(d, false);
      i += 2;
    } else if (c === "[") {
      let j = i + 1, cls = "[";
      if (src[j] === "^") { cls += "^"; j++; }
      if (src[j] === "]") { cls += "\\]"; j++; }
      while (j < n && src[j] !== "]") {
        const e = src[j];
        if (e === "\\") {
          const d = src[j + 1];
          if (d === "d") cls += "\\p{Nd}";
          else if (d === "w") cls += "\\p{L}\\p{N}_";
          else if (d === "s") cls += PY_WS;
          else if (d === "D" || d === "W" || d === "S") throw new SyntaxError(`\\${d} inside a character class is not supported`);
          else if (d === "x") { cls += "\\x" + src.slice(j + 2, j + 4); j += 4; continue; }
          else if (d === "u") { cls += "\\u" + src.slice(j + 2, j + 6); j += 6; continue; }
          else cls += literalEsc(d, true);
          j += 2;
        } else if (e === "[") { cls += "\\["; j++; }
        else { cls += e; j++; }
      }
      if (j >= n) throw new SyntaxError("unterminated character set");
      out += cls + "]";
      i = j + 1;
    } else if (c === "(" && src[i + 1] === "?") {
      const rest = src.slice(i);
      let m;
      if ((m = /^\(\?P<([A-Za-z_]\w*)>/.exec(rest))) { out += `(?<${m[1]}>`; i += m[0].length; }
      else if ((m = /^\(\?P=([A-Za-z_]\w*)\)/.exec(rest))) { out += `\\k<${m[1]}>`; i += m[0].length; }
      else if ((m = /^\(\?#[^)]*\)/.exec(rest))) { i += m[0].length; }
      else if ((m = /^\(\?([aiLmsux]+)\)/.exec(rest)) && i === 0 && /^[iu]+$/.test(m[1])) { i += m[0].length; }
      else { out += "(?"; i += 2; }
    } else if (c === "{") {
      const m = /^\{(\d*)(,(\d*))?\}/.exec(src.slice(i));
      if (m && (m[1] !== "" || m[2] !== undefined)) {
        out += m[2] === undefined ? `{${m[1]}}` : `{${m[1] || "0"},${m[3]}}`;
        i += m[0].length;
      } else { out += "\\{"; i++; }
    } else if (c === "}" || c === "]") { out += "\\" + c; i++; }
    else if (c === "$") { out += "(?=\\n?(?![\\s\\S]))"; i++; }
    else if (c === ".") { out += "[^\\n]"; i++; }
    else { out += c; i++; }
  }
  return out;
}
const compilePy = (pattern) => new RegExp(pyRegex(pattern), "iu");

// ---------- dates, places, names ----------

const MONTHS = new Map(Object.entries({
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, mai: 5, "máj": 5, jun: 6, june: 6, "jún": 6, jul: 7, july: 7, "júl": 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, szept: 9, oct: 10, october: 10,
  okt: 10, nov: 11, november: 11, dec: 12, december: 12,
}));
const HU_MONTHS = new Set(["mai", "máj", "jún", "júl", "szept", "okt"]);
const APPROX_SRC = pyRegex(
  "\\b(abt\\.?|about|circa|ca\\.?|c\\.|est\\.?|estimated|bef\\.?|before|aft\\.?|after|bet\\.?|between)\\b");
const APPROX = new RegExp(APPROX_SRC, "iu");
const APPROX_ALL = new RegExp(APPROX_SRC, "giu");
const RX_MDY = /^(\p{Nd}{1,2})\/(\p{Nd}{1,2})\/(\p{Nd}{4})$/u;
const RX_RANGE = new RegExp(`^\\p{Nd}{4}[${PY_WS}]*-[${PY_WS}]*\\p{Nd}{4}$`, "u");
const RX_Y4 = /\p{Nd}{4}/gu;
const RX_IS_Y = /^\p{Nd}{4}$/u;
const RX_IS_D = /^\p{Nd}{1,2}$/u;
const rstripDots = (s) => s.replace(/\.+$/, "");

/** Best-effort parse of the messy date strings found in Ancestry exports (build.py parse_date). */
export function parseDate(raw) {
  if (!raw) return null;
  const s = pyStrip(raw.replace(/<[^>]+>/g, ""));
  const qual = APPROX.exec(s);
  const out = { raw, text: s, approx: qual !== null, malformed: s !== pyStrip(raw) };
  out.qualifier = qual ? rstripDots(qual[1].toLowerCase()) : "";
  const s2 = pyStrip(s.replace(APPROX_ALL, "").replaceAll(",", " "));
  let y = null, m = null, d = null, mm;
  if ((mm = RX_MDY.exec(s2))) {
    m = pyInt(mm[1]); d = pyInt(mm[2]); y = pyInt(mm[3]);
    out.nonstandard = true;
  } else if (RX_RANGE.test(s2)) {
    const [a, b] = s2.match(RX_Y4).map(pyInt);
    y = Math.floor((a + b) / 2);
    out.approx = true;
    out.range = [a, b];
  } else {
    const toks = pySplit(s2);
    for (const t of toks) {
      const tl = rstripDots(t.toLowerCase());
      if (RX_IS_Y.test(t)) y = pyInt(t);
      else if (RX_IS_D.test(t)) d = pyInt(t);
      else if (MONTHS.has(tl)) {
        m = MONTHS.get(tl);
        if (HU_MONTHS.has(tl)) out.nonstandard = true;
      }
    }
    if (toks.length && MONTHS.has(rstripDots(toks[0].toLowerCase())) && d !== null) out.nonstandard = true; // "May 13 1963"
    if (y !== null && y < 1000) y = null;
  }
  if (y === null) {
    out.year = null;
    out.sort = null;
    out.malformed = true;
    return out;
  }
  Object.assign(out, { year: y, month: m, day: d });
  out.sort = y * 10000 + (m || 6) * 100 + (d || 15);
  if (out.qualifier === "bef" || out.qualifier === "before") out.sort -= 1;
  return out;
}

const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Display form of a parsed date (build.py fmt_date). */
export function fmtDate(pd) {
  if (!pd || pd.year === null || pd.year === undefined) return pd ? pd.text : "";
  const parts = [];
  if (pd.day && pd.month) parts.push(String(pd.day));
  if (pd.month) parts.push(MONTH_NAMES[pd.month] ?? String(pd.month)); // build.py raises IndexError for month > 12
  parts.push(String(pd.year));
  const s = parts.join(" ");
  const q = pd.qualifier;
  if (truthy(pd.range)) return `${pd.range[0]}–${pd.range[1]}`;
  if (q === "bef" || q === "before") return "before " + s;
  if (q === "aft" || q === "after") return "after " + s;
  if (pd.approx) return "c. " + s;
  return s;
}

const RX_COMMA = new RegExp(`[${PY_WS}]*,[${PY_WS}]*`, "gu");
const RX_WS2 = new RegExp(`[${PY_WS}]{2,}`, "gu");

export function cleanPlace(p) {
  if (!p) return "";
  p = pyStrip(pyStrip(p).replace(/^`+/, ""));
  p = p.replace(RX_COMMA, ", ");
  p = p.replace(RX_WS2, " ");
  return p.replace(/^[, ]+|[, ]+$/g, "");
}

export function displayName(person) {
  if (!truthy(person.names)) return "Unknown";
  const n = person.names[0];
  let g = pyStrip(n.given || "");
  const s = pyStrip(n.surname || "");
  if ((g === "?" || g === "") && (s === "?" || s === "")) return "Unknown";
  if (g === "?" || g === "") g = "(unknown)";
  return pyStrip(`${g} ${s}`);
}

/** Most specific dated event of a type (most precise date wins, then most citations, then has a place). */
export function bestEvent(events, typ, pdateOf = (e) => e.pdate) {
  const cands = events.filter((e) => e.type === typ && !truthy(e.misfiled));
  if (!cands.length) return null;
  const score = (e) => {
    const pd = pdateOf(e) || {};
    let prec = (pd.year ? 1 : 0) + (pd.month ? 1 : 0) + (pd.day ? 1 : 0);
    prec -= pd.approx ? 0.5 : 0;
    return [prec, (e.citations || []).length, e.place ? 1 : 0];
  };
  let best = cands[0], bs = score(best);
  for (const e of cands.slice(1)) {
    const sc = score(e);
    const cmp = sc[0] - bs[0] || sc[1] - bs[1] || sc[2] - bs[2];
    if (cmp > 0) { best = e; bs = sc; } // Python max(): first of equals wins
  }
  return best;
}

const RX_MISFILED = /^(death|birth|marriage) of /iu;
const isMisfiled = (e) => ["Death", "Birth", "Marriage"].includes(e.type) && RX_MISFILED.test(e.note || "");

// ---------- data checks ----------

/**
 * All data-quality issues, in build.py's order, with its exact messages and severities.
 *
 * `people` must carry the summary fields derive() adds (name, given, surname, birth, death) and
 * cleaned event places; `families` are as stored or derived. Event dates are re-parsed from `date`,
 * so derived (pdate-stripped) records work. IDs that are missing from `people`/`families` are
 * skipped, so this can be re-run on a scoped subset: messages then only name people in that subset.
 */
// Events that happen during a life (a residence, an occupation …), as opposed to birth, death and burial.
const LIFE_EVENTS = new Set(["Residence", "Occupation", "Arrival", "Departure", "Emigration", "Immigration", "Naturalization", "Military", "Census", "Education", "Graduation", "Retirement"]);
const RX_YEAR = /(?<![0-9])(1[6-9][0-9][0-9])(?![0-9])/g;

export function checkIssues(people, families, research = {}, sources = {}) {
  const P = people, F = families;
  const issues = [];
  const issue = (pid, severity, kind, message) => issues.push({ person: pid, severity, kind, message });
  const pdate = (e) => parseDate(get(e, "date"));
  const inP = (x) => has(P, x);

  // events (build.py "normalise events")
  for (const [pid, p] of Object.entries(P)) {
    for (const e of p.events) {
      const pd = pdate(e);
      if (isMisfiled(e)) {
        issue(pid, "warn", "misfiled-event",
          `${e.type} event dated ${pyStr(get(e, "date"))} is really a relative's event (“${e.note || ""}”). ` +
          "Ancestry exports these 'family events' as if they were the person's own.");
      }
      if (pd && (pd.malformed || pd.nonstandard) && get(e, "date")) {
        issue(pid, "info", "date-format",
          `Non-standard ${e.type.toLowerCase()} date “${e.date}” — rewrite as e.g. “17 Mar 1923”.`);
      }
    }
  }
  for (const [fid, f] of Object.entries(F)) {
    for (const e of f.events) {
      const pd = pdate(e);
      if (pd && get(e, "date") && (pd.malformed || pd.nonstandard)) {
        // build.py: f.husband or f.wife (only people present in `people`, so scoped runs don't point outside)
        const who = [get(f, "husband"), get(f, "wife")].find((x) => x && inP(x)) || null;
        issue(who, pd.year === null ? "warn" : "info",
          "date-format", `Family ${fid}: ${e.type.toLowerCase()} date “${e.date}” is malformed.`);
      }
    }
  }

  // per person (build.py "summary fields")
  for (const [pid, p] of Object.entries(P)) {
    const byears = [...new Set(p.events.filter((e) => e.type === "Birth").map((e) => pdate(e)?.year).filter((y) => y))]
      .sort((a, b) => a - b);
    if (byears.length > 1 && byears[byears.length - 1] - byears[0] >= 2) {
      issue(pid, "warn", "conflicting-dates", `Records disagree on birth year: ${byears.join(", ")}.`);
    }
    const bplaces = [...new Set(p.events.filter((e) => e.type === "Birth" && get(e, "place")).map((e) => e.place))];
    if (bplaces.length > 1) {
      issue(pid, "info", "conflicting-places", "Different birthplaces recorded: " + bplaces.sort(cmpStr).join(" / "));
    }
    if (!p.sex) issue(pid, "warn", "missing-sex", "Sex is not recorded.");
    const famc = p.famc.filter((fc) => has(F, fc));
    if (famc.length > 1) {
      const names = famc.map((fc) => {
        const f = F[fc];
        return [f.husband, f.wife].filter((x) => x && inP(x)).map((x) => displayName(P[x])).join(" & ");
      });
      issue(pid, "error", "multiple-parents",
        "Attached to more than one set of parents: " + names.join(" | ") + ". Only one can be right " +
        "(unless one is an adoptive/step family — mark it so).");
    }
    if (p.sex === "F") {
      const own = p.names.map((n) => (n.surname || "").trim()).filter((x) => x);
      const lower = [...new Set(own.map((x) => x.toLowerCase()))];
      if (lower.length === 1) {
        const husbands = p.fams.filter((fs) => has(F, fs) && F[fs].wife === pid && F[fs].husband && inP(F[fs].husband)).map((fs) => F[fs].husband);
        const fathers = p.famc.filter((fc) => has(F, fc) && F[fc].husband && inP(F[fc].husband)).map((fc) => F[fc].husband);
        const sur = (x) => ((P[x].names[0] || {}).surname || "").trim().toLowerCase();
        if (husbands.some((h) => sur(h) === lower[0]) && !fathers.some((h) => sur(h) === lower[0])) {
          issue(pid, "info", "married-surname",
            `Recorded only under her husband's surname (${own[0]}). Add her maiden name, or leave the surname blank if it isn't known.`);
        }
      }
    }
  }

  // families
  for (const [fid, f] of Object.entries(F)) {
    const h = f.husband && inP(f.husband) ? f.husband : null;
    const w = f.wife && inP(f.wife) ? f.wife : null;
    const kids = f.children.filter(inP);
    if (h && P[h].sex === "F") issue(h, "error", "sex-role", `Recorded as female but is the husband in family ${fid}.`);
    if (w && P[w].sex === "M") issue(w, "error", "sex-role", `Recorded as male but is the wife in family ${fid}.`);
    for (const [parentId, role, lo, hi] of [[h, "father", 16, 70], [w, "mother", 14, 50]]) {
      if (!parentId || !P[parentId].birth || !P[parentId].birth.year) continue;
      const py = P[parentId].birth.year;
      for (const c of kids) {
        const cb = P[c].birth;
        if (!cb || !cb.year) continue;
        const age = cb.year - py;
        if (age < lo || age > hi) {
          issue(c, "error", "parent-age",
            `${P[parentId].name} (b. ${py}) would be ${age} as ${role} at this birth (${cb.year}).`);
        }
      }
      const pd = P[parentId].death;
      if (pd && pd.sort) {
        for (const c of kids) {
          const cb = P[c].birth;
          if (cb && cb.sort && cb.sort > pd.sort + (role === "father" ? 10000 : 0)) {
            issue(c, "error", "born-after-parent-death",
              `Born ${cb.date} after ${role} ${P[parentId].name} died (${pd.date}).`);
          }
        }
      }
    }
    for (const e of f.events) {
      const pd = pdate(e);
      if (e.type === "Marriage" && pd && pd.year) {
        for (const sp of [h, w]) {
          if (sp && P[sp].birth && P[sp].birth.year) {
            const age = pd.year - P[sp].birth.year;
            if (age < 14) issue(sp, "error", "marriage-age", `Would be ${age} at marriage (${pyStr(get(e, "date"))}) in family ${fid}.`);
          }
        }
      }
    }
    // one parent here, but that parent is half of a couple in another family: the children are probably the couple's
    if (!f.husband !== !f.wife && f.children.length) {
      const par = f.husband || f.wife;
      if (inP(par)) {
        const other = P[par].fams.find((x) => x !== fid && has(F, x) && F[x].husband && F[x].wife);
        if (other) {
          issue(par, "info", "one-parent-family",
            `Family ${fid} records only ${P[par].name} as a parent, but ${P[par].name} also has a spouse in family ${other}. ` +
            "If these children belong to that couple, merge the two families.");
        }
      }
    }
  }
  for (const [pid, p] of Object.entries(P)) {
    if (p.birth && p.death && p.birth.sort && p.death.sort && p.death.sort < p.birth.sort) {
      issue(pid, "error", "death-before-birth", "Death date is before birth date.");
    }
    if (p.birth && p.death && p.birth.year && p.death.year && p.death.year - p.birth.year > 105) {
      issue(pid, "warn", "age", `Would have lived ${p.death.year - p.birth.year} years.`);
    }
    for (const e of p.events) {
      const y = pdate(e)?.year ?? null;
      if (y === null || !LIFE_EVENTS.has(e.type)) continue;
      if (p.birth && p.birth.year && y < p.birth.year) {
        issue(pid, "warn", "event-outside-life", `${e.type} dated ${e.date} is before the birth (${p.birth.year}); it may belong to someone else.`);
      } else if (p.death && p.death.year && y > p.death.year) {
        issue(pid, "warn", "event-outside-life", `${e.type} dated ${e.date} is after the death (${p.death.year}); it may belong to someone else.`);
      }
    }
    for (const t of ["Birth", "Death"]) {
      const n = p.events.filter((e) => e.type === t).length;
      if (n > 1) issue(pid, "info", "duplicate-event", `${n} ${t.toLowerCase()} events recorded. Keep one and move the citations onto it, or note why they differ.`);
    }
    for (const e of p.events) {
      const y = pdate(e)?.year ?? null;
      if (y === null) continue;
      for (const c of e.citations || []) {
        const title = (c.source && has(sources, c.source) && sources[c.source].title) || c.title || "";
        if (!/census/i.test(title)) continue;
        const years = [...new Set([...title.matchAll(RX_YEAR)].map((m) => parseInt(m[1], 10)))];
        if (years.length === 1 && y > years[0]) {
          issue(pid, "warn", "cited-after-record", `${e.type} dated ${e.date} cites the ${years[0]} census (“${title}”), taken before it.`);
          break;
        }
      }
    }
  }

  // possible duplicates: same exact death date, or same first given name + surname + birth year
  const byDeath = new Map();
  for (const [pid, p] of Object.entries(P)) {
    const d = p.death;
    if (d && d.sort && d.date && pySplit(d.date).length === 3 && !d.date.startsWith("c.")) {
      if (!byDeath.has(d.sort)) byDeath.set(d.sort, []);
      byDeath.get(d.sort).push(pid);
    }
  }
  for (const ids of byDeath.values()) {
    if (ids.length > 1) {
      for (const pid of ids) {
        const others = ids.filter((o) => o !== pid).map((o) => P[o].name);
        issue(pid, "error", "possible-duplicate",
          `Same exact death date (${P[pid].death.date}) as ${others.join(", ")} — likely the same person entered twice.`);
      }
    }
  }
  const seen = new Map();
  for (const [pid, p] of Object.entries(P)) {
    const key = [p.given.split(" ")[0].toLowerCase(), p.surname.toLowerCase(), p.birth ? p.birth.year : null];
    if (key[0] && key[1] && key[2]) {
      const k = JSON.stringify(key);
      if (!seen.has(k)) seen.set(k, { year: key[2], ids: [] });
      seen.get(k).ids.push(pid);
    }
  }
  for (const { year, ids } of seen.values()) {
    if (ids.length > 1) {
      for (const pid of ids) {
        issue(pid, "warn", "possible-duplicate",
          `Another person with the same name and birth year (${year}) exists: ` + ids.filter((o) => o !== pid).join(", "));
      }
    }
  }

  for (const rule of get(research, "place_rules", [])) {
    const rx = compilePy(rule.pattern);
    const before = get(rule, "before", 9999);
    for (const [pid, p] of Object.entries(P)) {
      for (const e of p.events) {
        const y = pdate(e)?.year ?? null;
        if (get(e, "place") && rx.test(e.place) && (y === null || y < before)) {
          issue(pid, "warn", "anachronistic-place", rule.message);
        }
      }
    }
  }
  return issues;
}

// ---------- relationships ----------

// `virtual`: a family with no parent recorded gets a stand-in parent ("~F12"), so its children are still siblings.
function familyGraph(people, families, { virtual = false } = {}) {
  const parentsOf = (pid) => {
    const out = [];
    for (const fc of people[pid]?.famc || []) {
      const f = families[fc];
      if (!f) continue;
      for (const x of [f.husband, f.wife]) if (x && has(people, x)) out.push(x);
      if (virtual && !f.husband && !f.wife) out.push(`~${fc}`);
    }
    return out;
  };
  const ancestors = (pid) => {
    const dist = new Map([[pid, 0]]);
    const q = [pid];
    for (let qi = 0; qi < q.length; qi++) {
      const x = q[qi];
      for (const par of parentsOf(x)) {
        if (!dist.has(par)) { dist.set(par, dist.get(x) + 1); q.push(par); }
      }
    }
    return dist;
  };
  function* neighbours(pid) {
    const p = people[pid];
    for (const fid of [...p.famc, ...p.fams]) {
      const f = families[fid];
      if (!f) continue;
      for (const x of [f.husband, f.wife, ...f.children]) if (x && x !== pid && has(people, x)) yield x;
    }
  }
  return { ancestors, neighbours };
}

/** Ancestor distances from a person: Map id -> generations up (self = 0), BFS order. */
export function ancestorsOf(people, families, pid) {
  return familyGraph(people, families).ancestors(pid);
}

const ordinal = (n) => ({ 1: "1st", 2: "2nd", 3: "3rd" })[n] || `${n}th`;
const gendered = (sex, m, f, n) => (sex === "M" ? m : sex === "F" ? f : n);

/**
 * Relationship labels relative to `homeId`: {id: {relation, relationVia}} for every person.
 * relation is a blood relation ("2nd cousin once removed"), a spouse label ("wife of uncle"), "Self",
 * or null; relationVia is the nearest labelled relative of an unlabelled person, or null.
 */
export function relationLabels(people, families, homeId) {
  const P = people;
  const { ancestors, neighbours } = familyGraph(people, families, { virtual: true });
  const homeAnc = ancestors(homeId);

  const bloodRelation = (pid) => {
    if (pid === homeId) return "Self";
    const anc = ancestors(pid);
    let best = null;
    for (const [a, da] of anc) {
      if (!homeAnc.has(a)) continue;
      const t = homeAnc.get(a) + da;
      if (best === null || t < best[0] || (t === best[0] && cmpStr(a, best[1]) < 0)) best = [t, a];
    }
    if (best === null) return null;
    const ca = best[1];
    const up = homeAnc.get(ca), down = anc.get(ca);
    const sex = P[pid].sex;
    if (down === 0) {
      const base = gendered(sex, "father", "mother", "parent");
      if (up === 1) return base;
      if (up === 2) return "grand" + base;
      return (up === 3 ? "great-" : `${ordinal(up - 2)} great-`) + "grand" + base;
    }
    if (up === 0) {
      const base = gendered(sex, "son", "daughter", "child");
      if (down === 1) return base;
      if (down === 2) return "grand" + base;
      return (down === 3 ? "great-" : `${ordinal(down - 2)} great-`) + "grand" + base;
    }
    if (up === 1 && down === 1) return gendered(sex, "brother", "sister", "sibling");
    if (up === 1) {
      const base = gendered(sex, "nephew", "niece", "nibling");
      if (down === 2) return base;
      return (down === 3 ? "grand" : (down === 4 ? "great-" : `${ordinal(down - 3)} great-`) + "grand") + base;
    }
    if (down === 1) {
      const base = gendered(sex, "uncle", "aunt", "parent's sibling");
      if (up === 2) return base;
      if (up === 3) return "great-" + base;
      return `${ordinal(up - 2)} great-` + base;
    }
    const n = Math.min(up, down) - 1;
    const r = Math.abs(up - down);
    let rel = `${ordinal(n)} cousin`;
    if (r) rel += r === 1 ? " once removed" : r === 2 ? " twice removed" : ` ${r}× removed`;
    return rel;
  };

  const rel = new Map();
  for (const pid of Object.keys(P)) {
    const r = bloodRelation(pid);
    if (r) rel.set(pid, r);
  }
  for (const [pid, p] of Object.entries(P)) {
    if (rel.has(pid)) continue;
    for (const fs of p.fams) {
      const f = families[fs];
      if (!f) continue;
      let sp = f.husband === pid ? f.wife : f.husband;
      if (sp && !has(P, sp)) sp = null;
      if (sp && rel.has(sp) && rel.get(sp) !== "Self") {
        rel.set(pid, gendered(p.sex, "husband", "wife", "spouse") + " of " + rel.get(sp));
        break;
      }
      if (sp && rel.get(sp) === "Self") {
        rel.set(pid, gendered(p.sex, "husband", "wife", "spouse"));
        break;
      }
    }
  }
  // anyone still unlabelled: the nearest labelled relative (BFS through the family graph)
  const via = new Map();
  for (const pid of Object.keys(P)) {
    if (rel.has(pid)) continue;
    const seen = new Set([pid]);
    const q = [pid];
    for (let qi = 0; qi < q.length; qi++) {
      let hit = null;
      for (const n of neighbours(q[qi])) {
        if (seen.has(n)) continue;
        if (rel.has(n) && rel.get(n) !== "Self") { hit = n; break; }
        seen.add(n);
        q.push(n);
      }
      if (hit) { via.set(pid, hit); break; }
    }
  }
  const out = {};
  for (const pid of Object.keys(P)) out[pid] = { relation: rel.get(pid) ?? null, relationVia: via.get(pid) ?? null };
  return out;
}

// ---------- the whole derivation ----------

/**
 * Compute the family.json bundle from stored data, exactly as tools/build.py does.
 * Does not mutate its input. `today` ("YYYY-MM-DD") stands in for date.today().
 */
export function derive(input, { today } = {}) {
  const { raw, research = {}, places = {}, aliases = {} } = structuredClone(input);
  today = today || new Date().toISOString().slice(0, 10);
  const P = raw.people, F = raw.families, S = raw.sources;
  const overrides = get(research, "overrides", {});

  // normalise events
  for (const [pid, p] of Object.entries(P)) {
    const ov = get(overrides, pid, {});
    if (truthy(get(ov, "sex"))) {
      p.sexOriginal = p.sex;
      p.sex = ov.sex;
    }
    if (truthy(get(ov, "name"))) {
      p.names.unshift({ given: get(ov.name, "given", ""), surname: get(ov.name, "surname", ""), suffix: "", type: "research" });
    }
    for (const e of p.events) {
      e.pdate = parseDate(get(e, "date"));
      if (get(e, "place")) e.place = cleanPlace(e.place);
      if (isMisfiled(e)) e.misfiled = true;
    }
  }
  for (const f of Object.values(F)) {
    for (const e of f.events) {
      e.pdate = parseDate(get(e, "date"));
      if (get(e, "place")) e.place = cleanPlace(e.place);
    }
  }

  // summary fields
  const thisYear = parseInt(today.slice(0, 4), 10);
  for (const [pid, p] of Object.entries(P)) {
    p.name = displayName(p);
    p.given = truthy(p.names) ? p.names[0].given : "";
    p.surname = truthy(p.names) ? p.names[0].surname : "";
    const b = bestEvent(p.events, "Birth"), d = bestEvent(p.events, "Death"), bu = bestEvent(p.events, "Burial");
    const summary = (ev) => ev ? {
      date: fmtDate(ev.pdate), year: ev.pdate ? ev.pdate.year : null,
      place: get(ev, "place", ""), sort: ev.pdate ? ev.pdate.sort : null,
    } : null;
    p.birth = summary(b);
    p.death = summary(d);
    p.burial = bu ? { place: get(bu, "place", ""), note: get(bu, "note", "") } : null;
    const by = p.birth ? p.birth.year : null;
    p.living = !p.death && (by === null || by > thisYear - 100) && !truthy(get(p, "deceased"));
    if (by === null && !p.death) {
      // unknown birth: treat as deceased if any dated event before 1930
      const yrs = p.events.filter((e) => e.pdate && e.pdate.year).map((e) => e.pdate.year);
      p.living = yrs.length > 0 && Math.min(...yrs) > 1930;
      if (!yrs.length) {
        p.living = false;
        p.livingUnknown = true;
      }
    }
    const ovLiving = get(get(overrides, pid, {}), "living");
    if (ovLiving !== null) p.living = ovLiving;
  }
  // No birth year of their own: estimate one from close relatives (parent + 25, spouse or sibling the same,
  // child − 25; the youngest estimate wins) and treat them as living when it falls within the last 100 years.
  const est = {};
  for (const [pid, p] of Object.entries(P)) if (p.birth && p.birth.year) est[pid] = p.birth.year;
  for (let pass = 0; pass < 3; pass++) {
    const next = { ...est };
    for (const [pid, p] of Object.entries(P)) {
      if (has(est, pid)) continue;
      const c = [];
      for (const fc of p.famc) {
        const f = get(F, fc);
        if (!f) continue;
        for (const x of [f.husband, f.wife]) if (x && has(est, x)) c.push(est[x] + 25);
        for (const x of f.children) if (x !== pid && has(est, x)) c.push(est[x]);
      }
      for (const fs of p.fams) {
        const f = get(F, fs);
        if (!f) continue;
        for (const x of [f.husband, f.wife]) if (x && x !== pid && has(est, x)) c.push(est[x]);
        for (const x of f.children) if (has(est, x)) c.push(est[x] - 25);
      }
      if (c.length) next[pid] = Math.max(...c);
    }
    Object.assign(est, next);
  }
  // The estimate decides both ways for anyone without a birth year or a death: a 1940s emigration alone doesn't make
  // someone whose spouse was born in 1907 living. A dated record from the last 30 years still counts as alive.
  for (const [pid, p] of Object.entries(P)) {
    if ((p.birth && p.birth.year) || p.death || truthy(get(p, "deceased")) || get(get(overrides, pid, {}), "living") !== null) continue;
    if (!has(est, pid)) continue;
    const recent = p.events.some((e) => e.pdate && e.pdate.year && e.pdate.year >= thisYear - 30);
    p.living = est[pid] > thisYear - 100 || recent;
  }

  const issues = checkIssues(P, F, research, S);

  // places
  const gaz = get(places, "places", []);
  const compiled = gaz.map((pl) => [pl, pl.match.map(compilePy)]);
  const placeKey = (txt) => {
    for (const [pl, rxs] of compiled) if (rxs.some((r) => r.test(txt))) return pl.key;
    return null;
  };
  for (const coll of [P, F]) {
    for (const x of Object.values(coll)) for (const e of x.events) if (get(e, "place")) e.placeKey = placeKey(e.place);
  }

  // relationships & branches
  const home = get(research, "home_person") || Object.keys(P)[0];
  const graph = familyGraph(P, F);
  const homeAnc = graph.ancestors(home);
  const labels = relationLabels(P, F, home);
  for (const [pid, p] of Object.entries(P)) {
    p.relation = labels[pid].relation;
    if (labels[pid].relationVia !== null) p.relationVia = labels[pid].relationVia;
  }

  const branch = new Map();
  for (const c of new Set(get(research, "core_people", [home]))) branch.set(c, "home");
  const q = [];
  for (const b of get(research, "branches", [])) {
    if (has(P, b.root)) {
      branch.set(b.root, b.key);
      q.push(b.root);
    }
  }
  for (let qi = 0; qi < q.length; qi++) {
    const x = q[qi];
    for (const n of graph.neighbours(x)) {
      if (!branch.has(n)) {
        branch.set(n, branch.get(x));
        q.push(n);
      }
    }
  }
  for (const [pid, p] of Object.entries(P)) {
    p.branch = branch.has(pid) ? branch.get(pid) : "other";
    p.direct = homeAnc.has(pid);
    p.generation = homeAnc.has(pid) ? homeAnc.get(pid) : null;
  }

  // research layer
  const status = get(research, "people_status", {});
  for (const [pid, p] of Object.entries(P)) {
    const st = get(status, pid, {});
    p.status = get(st, "status", "unverified");
    p.statusNote = get(st, "note", "");
    p.issues = issues.filter((i) => i.person === pid);
  }
  for (const d of get(research, "duplicates", [])) {
    for (const a of d.ids) {
      if (has(P, a)) {
        if (!has(P[a], "duplicateOf")) P[a].duplicateOf = [];
        P[a].duplicateOf.push(...d.ids.filter((b) => b !== a));
      }
    }
  }

  // strip noise before shipping
  for (const coll of [P, F]) {
    for (const x of Object.values(coll)) {
      for (const e of x.events) {
        const pd = get(e, "pdate");
        e.dateDisplay = pd ? fmtDate(pd) : "";
        e.sort = pd ? get(pd, "sort") : null;
        delete e.pdate;
      }
    }
  }

  const researchOut = {};
  for (const [k, v] of Object.entries(research)) if (k !== "overrides" && k !== "place_rules") researchOut[k] = v;
  const placesOut = {};
  for (const pl of gaz) placesOut[pl.key] = { name: pl.name, lat: pl.lat, lng: pl.lng };

  return {
    generated: today,
    home,
    people: P,
    families: F,
    sources: S,
    media: raw.media,
    issues,
    aliases: aliases || {},
    research: researchOut,
    places: placesOut,
  };
}
