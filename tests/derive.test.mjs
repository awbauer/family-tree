// Parity tests: worker/derive.js must produce exactly what tools/build.py writes to family.json.
//   node --test tests/
// Needs python3. The private-data check runs only when family-data/ exists, and never prints
// anything from it beyond person/family IDs and field names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { derive, parseDate, fmtDate, displayName, relationLabels, checkIssues, pyRegex } from "../worker/derive.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRIVATE = path.join(ROOT, "family-data");

function build(dataDir, outDir, { quiet }) {
  const r = spawnSync("python3", [path.join(ROOT, "tools/build.py"), "--data", dataDir, "--out", outDir,
    "--raw-out", path.join(outDir, "raw.json")], { encoding: "utf8" });
  // build.py's output can name places from the data, so it is only shown for the example family
  assert.equal(r.status, 0, quiet ? `build.py exited with ${r.status}` : `build.py failed:\n${r.stdout}\n${r.stderr}`);
}

/** Paths where a and b differ (JSON values). */
function diffs(a, b, p = [], out = [], limit = 50) {
  if (out.length >= limit) return out;
  if (a === b) return out;
  const ta = Array.isArray(a) ? "array" : a === null ? "null" : typeof a;
  const tb = Array.isArray(b) ? "array" : b === null ? "null" : typeof b;
  if (ta !== tb || (ta !== "object" && ta !== "array")) { out.push(p); return out; }
  if (ta === "array" && a.length !== b.length) out.push([...p, "length"]);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!(k in a) || !(k in b)) out.push([...p, k]);
    else diffs(a[k], b[k], [...p, k], out, limit);
    if (out.length >= limit) break;
  }
  return out;
}

/** For private data: keep only collection, record ID (people/families) or index, and field name. */
function redact(p) {
  const [top, id, field] = p;
  if (top === "people" || top === "families") return [top, id, field].filter((x) => x !== undefined).join(".");
  if (top === "issues") return `issues[${id}]${field ? "." + field : ""}`;
  return top;
}

function parity(dataDir, outDir, { privateData }) {
  build(dataDir, outDir, { quiet: privateData });
  const expected = JSON.parse(fs.readFileSync(path.join(outDir, "family.json"), "utf8"));
  const input = JSON.parse(fs.readFileSync(path.join(outDir, "raw.json"), "utf8"));
  const before = JSON.stringify(input);
  const actual = derive(input, { today: expected.generated });
  assert.equal(JSON.stringify(input), before, "derive() mutated its input");
  const found = diffs(JSON.parse(JSON.stringify(actual)), expected);
  if (found.length) {
    const out = path.join(outDir, "derived.json");
    fs.writeFileSync(out, JSON.stringify(actual));
    const where = found.map((p) => "  " + (privateData ? redact(p) : p.join("."))).filter((x, i, xs) => xs.indexOf(x) === i);
    assert.fail(`derive() differs from build.py at:\n${where.join("\n")}\n` +
      `compare ${path.join(outDir, "family.json")} with ${out}`);
  }
  // JSON round trip must not hide anything (undefined values, NaN, class instances)
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), actual);
  return { actual, expected };
}

test("parity with build.py on the example family", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "derive-example-"));
  const { actual } = parity(path.join(ROOT, "example"), out, { privateData: false });
  assert.ok(Object.keys(actual.people).length > 10);
  assert.ok(actual.issues.length > 0, "example should exercise the data checks");
  fs.rmSync(out, { recursive: true, force: true });
});

test("parity with build.py on local family-data/", { skip: !fs.existsSync(PRIVATE) && "no family-data/ here" }, () => {
  // build/ is git-ignored and already holds private build output; keep failure artifacts there
  const out = path.join(ROOT, "build", "derive-parity");
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  parity(PRIVATE, out, { privateData: true });
  fs.rmSync(out, { recursive: true, force: true });
});

test("relationLabels and checkIssues match what derive() uses", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "derive-example-"));
  build(path.join(ROOT, "example"), out, { quiet: false });
  const input = JSON.parse(fs.readFileSync(path.join(out, "raw.json"), "utf8"));
  fs.rmSync(out, { recursive: true, force: true });
  const b = derive(input, { today: "2026-01-01" });
  const labels = relationLabels(b.people, b.families, b.home);
  for (const [id, p] of Object.entries(b.people)) {
    assert.equal(labels[id].relation, p.relation, id);
    assert.equal(labels[id].relationVia, p.relationVia ?? null, id);
  }
  assert.equal(labels[b.home].relation, "Self");
  // re-running on the derived bundle gives the same issues
  assert.deepEqual(checkIssues(b.people, b.families, input.research), b.issues);
  // labels relative to someone else
  const other = Object.keys(b.people).find((id) => id !== b.home && b.people[id].direct);
  assert.equal(relationLabels(b.people, b.families, other)[other].relation, "Self");
  // a scoped subset never names people outside it
  const keep = Object.fromEntries(Object.entries(b.people).filter(([, p]) => p.branch === "home"));
  const hidden = Object.values(b.people).filter((p) => !(p.id in keep)).map((p) => p.name);
  for (const i of checkIssues(keep, b.families, input.research)) {
    assert.ok(i.person === null || i.person in keep);
    for (const n of hidden) if (!Object.values(keep).some((p) => p.name === n)) assert.ok(!i.message.includes(n), i.message);
  }
});

// Expected values produced by tools/build.py parse_date / fmt_date.
const DATES = {
  "17 Mar 1923": [{ approx: false, malformed: false, qualifier: "", year: 1923, month: 3, day: 17, sort: 19230317 }, "17 Mar 1923"],
  "Mar 1923": [{ year: 1923, month: 3, day: null, sort: 19230315 }, "Mar 1923"],
  "1923": [{ year: 1923, month: null, day: null, sort: 19230615 }, "1923"],
  "abt 1900": [{ approx: true, qualifier: "abt", year: 1900, sort: 19000615 }, "c. 1900"],
  "Abt. 1900": [{ approx: true, qualifier: "abt", sort: 19000615 }, "c. 1900"],
  // quirk: \b after "c." needs a following word character, so "c. 1900" is not approximate
  "c. 1900": [{ approx: false, qualifier: "", year: 1900 }, "1900"],
  "c.1900": [{ approx: true, qualifier: "c", year: 1900 }, "c. 1900"],
  "ca 1900": [{ approx: true, qualifier: "ca" }, "c. 1900"],
  "est. 1850": [{ approx: true, qualifier: "est", year: 1850 }, "c. 1850"],
  "bef 1 Jan 1900": [{ approx: true, qualifier: "bef", month: 1, day: 1, sort: 19000100 }, "before 1 Jan 1900"],
  "before 1900": [{ qualifier: "before", sort: 19000614 }, "before 1900"],
  "aft 1880": [{ qualifier: "aft", sort: 18800615 }, "after 1880"],
  // quirk: "between" keeps the last year
  "bet 1900 and 1910": [{ approx: true, qualifier: "bet", year: 1910, sort: 19100615 }, "c. 1910"],
  "1900-1910": [{ approx: true, range: [1900, 1910], year: 1905, sort: 19050615 }, "1900–1910"],
  "1900 - 1911": [{ range: [1900, 1911], year: 1905 }, "1900–1911"],
  "5/13/1963": [{ nonstandard: true, year: 1963, month: 5, day: 13, sort: 19630513 }, "13 May 1963"],
  "May 13 1963": [{ nonstandard: true, month: 5, day: 13 }, "13 May 1963"],
  "13 máj 1920": [{ nonstandard: true, month: 5, day: 13, sort: 19200513 }, "13 May 1920"],
  "3 okt 1901": [{ nonstandard: true, month: 10, day: 3 }, "3 Oct 1901"],
  "1920. szept. 3.": [{ nonstandard: true, malformed: true, year: null, sort: null }, "1920. szept. 3."],
  "<i>17 Mar 1923</i>": [{ text: "17 Mar 1923", malformed: true, year: 1923, sort: 19230317 }, "17 Mar 1923"],
  "  17 Mar 1923  ": [{ text: "17 Mar 1923", malformed: false, sort: 19230317 }, "17 Mar 1923"],
  "unknown": [{ malformed: true, year: null, sort: null }, "unknown"],
  "999": [{ malformed: true, year: null }, "999"],
  "0999": [{ malformed: true, year: null }, "0999"],
  "12 Sep": [{ malformed: true, year: null }, "12 Sep"],
  "Sept 1950": [{ month: 9, sort: 19500915 }, "Sep 1950"],
  "éca 1900": [{ approx: false, qualifier: "" }, "1900"],
  "1 2 1900 1901": [{ year: 1901, day: 2, month: null, sort: 19010602 }, "1901"],
  "Dec, 1899": [{ year: 1899, month: 12, sort: 18991215 }, "Dec 1899"],
  "١٩٠٠": [{ year: 1900, sort: 19000615 }, "1900"],
  " ": [{ text: "", malformed: true, year: null }, ""],
};

test("parseDate / fmtDate edge cases match build.py", async (t) => {
  for (const [raw, [want, shown]] of Object.entries(DATES)) {
    await t.test(JSON.stringify(raw), () => {
      const pd = parseDate(raw);
      for (const [k, v] of Object.entries(want)) assert.deepEqual(pd[k], v, `${k} of ${raw}`);
      if (!("nonstandard" in want)) assert.equal(pd.nonstandard, undefined);
      if (pd.year === null) assert.ok(!("month" in pd) && !("day" in pd));
      assert.equal(fmtDate(pd), shown);
    });
  }
  assert.equal(parseDate(""), null);
  assert.equal(parseDate(null), null);
  assert.equal(fmtDate(null), "");
  // build.py crashes (IndexError) on a month > 12 from m/d/y; we only check the parse
  assert.equal(parseDate("13/05/1990").sort, 19901305);
});

test("displayName", () => {
  assert.equal(displayName({ names: [] }), "Unknown");
  assert.equal(displayName({ names: [{ given: "?", surname: "" }] }), "Unknown");
  assert.equal(displayName({ names: [{ given: "", surname: "Hartley" }] }), "(unknown) Hartley");
  assert.equal(displayName({ names: [{ given: " Eva ", surname: "" }] }), "Eva");
});

test("Python regex translation", () => {
  const rx = (p) => new RegExp(pyRegex(p), "iu");
  assert.ok(rx("^france$").test("France\n"));
  assert.ok(!rx("^france$").test("France, Paris"));
  assert.ok(rx("\\bplze").test("Plzeň"));
  assert.ok(!rx("n\\b").test("Plzeňa"), "\\b is Unicode-aware");
  assert.ok(rx("\\bň").test("x ň"));
  assert.ok(rx("a{").test("a{"));
  assert.ok(rx("[]x]").test("]"));
  assert.ok(rx("(?P<c>x)(?P=c)").test("xx"));
  assert.ok(!rx("a.b").test("a\nb"));
  assert.ok(rx("a.b").test("a\rb"));
});
