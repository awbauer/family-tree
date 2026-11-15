// What a research agent sees of a fetched web page. Every model call re-sends the whole conversation, so a page must
// not land in it whole: the agent gets the outline and a short window, or only the passages that mention what it is
// looking for, and asks for more where it needs it. Plain functions (tested without the agent runtime).
const TAG = "untrusted_web_content";
const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const neutral = (s) => String(s).replace(new RegExp(`</?${TAG}`, "gi"), (m) => m.replace("<", "&lt;"));

/** The page's headings with their offsets, so the agent can jump to a section. */
export function outline(content, max = 30) {
  const out = [];
  const re = /^(#{1,4})\s+(.+)$/gm;
  let m;
  while ((m = re.exec(content)) && out.length < max) out.push({ offset: m.index, level: m[1].length, title: m[2].trim().slice(0, 120) });
  return out;
}

/**
 * The passages of `content` that mention any of the words in `find` (accents and case ignored), best first by how
 * many different words they contain, then in page order. Each passage is about `radius` characters either side of
 * a match, cut at line ends where possible; overlapping passages merge. At most `budget` characters in all.
 */
export function passages(content, find, { radius = 350, budget = 6000 } = {}) {
  const text = String(content || ""), hay = fold(text);
  const terms = [...new Set(fold(find).split(/[^a-z0-9]+/).filter((t) => t.length >= 2))];
  if (!terms.length) return [];
  const hits = [];
  for (const t of terms) {
    let i = hay.indexOf(t);
    while (i >= 0 && hits.length < 400) { hits.push(i); i = hay.indexOf(t, i + t.length); }
  }
  hits.sort((a, b) => a - b);
  // windows around hits, merged when they overlap
  const wins = [];
  for (const h of hits) {
    let s = Math.max(0, h - radius), e = Math.min(text.length, h + radius);
    const ls = text.lastIndexOf("\n", h), le = text.indexOf("\n", h);
    if (ls >= s) s = ls + 1;
    if (le >= 0 && le <= e) e = le;
    const last = wins[wins.length - 1];
    if (last && s <= last.end) last.end = Math.max(last.end, e);
    else wins.push({ start: s, end: e });
  }
  for (const w of wins) { const seg = fold(text.slice(w.start, w.end)); w.score = terms.filter((t) => seg.includes(t)).length; }
  const chosen = [];
  let used = 0;
  for (const w of [...wins].sort((a, b) => b.score - a.score || a.start - b.start)) {
    const len = w.end - w.start;
    if (used + len > budget) { if (!chosen.length) chosen.push({ ...w, end: w.start + budget }); break; }
    chosen.push(w); used += len;
  }
  return chosen.sort((a, b) => a.start - b.start).map((w) => ({ offset: w.start, text: text.slice(w.start, w.end).trim() }));
}

/**
 * The text a research agent reads for one web_fetch call. `page` is the fetched page ({finalUrl, title, content, …});
 * `render(window)` renders a window the standard way (agents/webfetch). With `find`: only the matching passages.
 * Otherwise the window at `offset`, preceded on the first call by the page's outline when the page is longer.
 */
export function pageView(page, { offset = 0, find = "", chars = 6000, render }) {
  const content = String(page.content || ""), total = content.length;
  const url = page.finalUrl || page.url || "";
  if (String(find || "").trim()) {
    const ps = passages(content, find, { budget: chars });
    if (!ps.length) return `web_fetch: ${url} · ${total} chars · nothing on this page mentions "${String(find).slice(0, 100)}". Try other words, or read it with offset.`;
    return [`web_fetch: ${url} · ${total} chars · ${ps.length} passage${ps.length > 1 ? "s" : ""} mentioning "${String(find).slice(0, 100)}" (read around one with offset)`,
      `<${TAG}>`, ...ps.map((p) => `[at offset ${p.offset}]\n${neutral(p.text)}`), `</${TAG}>`].join("\n");
  }
  const head = [];
  if (!offset && total > chars) {
    const o = outline(content);
    if (o.length) head.push(`Outline (heading · offset): ${o.map((h) => `${"#".repeat(h.level)} ${h.title} · ${h.offset}`).join(" | ")}`);
    head.push(`This page is ${total} characters; showing the first ${chars}. Use find to pick out passages, or offset to read on.`);
  }
  return [...head, render({ offset, pageChars: chars })].join("\n");
}
