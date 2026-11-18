// Meaning-based search over the whole family history with Cloudflare AI Search: every person, story, finding and
// catalogued source as a Markdown document, plus the attachments and reports in R2 (PDFs, Markdown, text).
//
// The index holds everything, like D1 does; it lives in the same Cloudflare account and is never public (leave the
// instance's public endpoint off). Who sees what is decided when results come back: every hit is checked against the
// caller's scoped bundle (worker/scope.js), exactly like the rest of the app, and snippets are scrubbed of anyone the
// caller's view hides. A hit the caller may not see is dropped, never shortened.
//
// Setup: the `ai_search_namespaces` binding AI_SEARCH (wrangler.jsonc). The Worker creates its instance (default name
// "family-tree", or AI_SEARCH_INSTANCE) on the first sync. Sync runs every 15 minutes from the cron, does nothing when
// the data hasn't changed, and uploads only documents whose content changed (table ai_search_items, migration 0012).
// Set AI_SEARCH_ENABLED=false to switch it off. docs/agents/operations.md → AI Search.
import { fullBundle } from "./bundle.js";
import { dataVersion, now } from "./db.js";
import { documentType } from "./documents.ts";
import { detailsVisible } from "./edit-access.js";
import { followAlias, scrubFor } from "./scope.js";

export const SYNC_CRON = "*/15 * * * *";
const MAX_CHANGES_PER_RUN = 150;
const DOC_TYPES = { "application/pdf": "pdf", "text/markdown": "md", "text/plain": "txt" };
const DOC_LIMIT = 10 * 1024 * 1024;

export const enabled = (env) => !!(env.AI_SEARCH && typeof env.AI_SEARCH.get === "function") && env.AI_SEARCH_ENABLED !== "false";
const instanceName = (env) => env.AI_SEARCH_INSTANCE || "family-tree";
const handle = (env) => env.AI_SEARCH.get(instanceName(env));

// ---------------------------------------------------------------- documents
const line = (...parts) => parts.filter((x) => x != null && String(x).trim() !== "").join(", ");
const citeText = (sources, c) => {
  if (!c) return "";
  const s = (c.source && sources[c.source]) || {};
  return line(s.title || c.title, c.page, c.text && `"${c.text}"`, c.note);
};
const label = (P, id) => (P[id] ? `${P[id].name} (${id})` : id);

export function personDoc(full, id) {
  const P = full.people, F = full.families, S = full.sources || {}, p = P[id];
  const out = [`# ${p.name} (${id})`];
  const years = line(p.birth && p.birth.date && `born ${p.birth.date}${p.birth.place ? ` in ${p.birth.place}` : ""}`, p.death && p.death.date && `died ${p.death.date}${p.death.place ? ` in ${p.death.place}` : ""}`);
  if (years) out.push(years);
  const other = (p.names || []).slice(1).map((n) => `${n.given || ""} ${n.surname || ""}`.trim()).filter(Boolean);
  if (other.length) out.push(`Also recorded as: ${other.join("; ")}`);
  out.push(line(p.sex && `sex ${p.sex}`, p.branch && `branch ${p.branch}`, p.living && "living", p.relation && `the home person's ${p.relation}`));
  if ((p.events || []).length) {
    out.push("", "## Life events");
    for (const e of p.events) {
      const cites = (e.citations || []).map((c) => citeText(S, c)).filter(Boolean);
      out.push(`- ${line(e.type, e.date, e.place, e.value, e.age && `age ${e.age}`, e.note)}${cites.length ? ` (sources: ${cites.join("; ")})` : ""}`);
    }
  }
  const parents = [], siblings = [], spouses = [], children = [];
  for (const fid of p.famc || []) { const f = F[fid]; if (!f) continue; [f.husband, f.wife].filter(Boolean).forEach((x) => parents.push(label(P, x))); (f.children || []).filter((x) => x !== id).forEach((x) => siblings.push(label(P, x))); }
  for (const fid of p.fams || []) {
    const f = F[fid]; if (!f) continue;
    const sp = f.husband === id ? f.wife : f.husband;
    const m = (f.events || []).find((e) => e.type === "Marriage");
    if (sp) spouses.push(`${label(P, sp)}${m ? ` (married ${line(m.date, m.place)})` : ""}`);
    (f.children || []).forEach((x) => children.push(label(P, x)));
  }
  if (parents.length + siblings.length + spouses.length + children.length) {
    out.push("", "## Family");
    if (parents.length) out.push(`Parents: ${parents.join("; ")}`);
    if (siblings.length) out.push(`Siblings: ${siblings.join("; ")}`);
    if (spouses.length) out.push(`Spouses: ${spouses.join("; ")}`);
    if (children.length) out.push(`Children: ${children.join("; ")}`);
  }
  const cites = (p.citations || []).map((c) => citeText(S, c)).filter(Boolean);
  if (cites.length) out.push("", "## Sources", ...cites.map((c) => `- ${c}`));
  if ((p.notes || []).length) out.push("", "## Notes", ...p.notes.map((n) => String(typeof n === "string" ? n : n.text || "")));
  if (p.profile && p.profile.text) out.push("", "## Profile", p.profile.text);
  const files = ((full.research && full.research.media) || {})[id] || [];
  const described = files.filter((m) => m && (m.caption || m.transcript));
  if (described.length) {
    out.push("", "## Photos and documents");
    for (const m of described) out.push(`- ${line(m.caption || m.file, m.type, m.date, m.place)}${m.transcript ? `\n  Transcript: ${m.transcript.replace(/\s+/g, " ")}` : ""}`);
  }
  if (p.statusNote) out.push("", `Research status: ${p.status}. ${p.statusNote}`);
  return out.join("\n");
}

const storyDoc = (full, s) => [`# ${s.title}`, line(s.era && `Era: ${s.era}`, (s.people || []).length && `About: ${s.people.map((x) => label(full.people, x)).join("; ")}`), "",
  String(s.body || "").replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, (_, x) => label(full.people, x.trim())),
  ...((s.sources || []).length ? ["", "## Sources", ...s.sources.map((x) => `- ${line(x.title, x.page, x.note, x.url)}`)] : [])].join("\n");

const findingDoc = (full, f) => [`# Finding ${f.id}: ${f.kind || "finding"}${f.person ? ` about ${label(full.people, f.person)}` : ""}`,
  line(f.field && `field ${f.field}`, f.confidence && `confidence ${f.confidence}`, f.resolution && f.resolution.status && `status ${f.resolution.status}`),
  f.claim ? `Claim: ${f.claim}` : "", String(f.finding || ""),
  ...((f.sources || []).length ? ["", "## Sources", ...f.sources.map((x) => `- ${line(x.title, x.page, x.note, x.url)}`)] : [])].filter((x) => x !== "").join("\n");

const sourceDoc = (id, s) => [`# ${s.title || id} (${id})`, line(s.type, s.author, s.publication, s.repository, s.url), s.note || "", s.text ? `\n## Transcription\n${s.text}` : ""].filter(Boolean).join("\n");

/** Every document the index should hold: [{key, text?, file?, type?}]. Keys are "kind/id.ext". */
export function documents(full) {
  const docs = [];
  for (const id of Object.keys(full.people)) docs.push({ key: `person/${id}.md`, text: personDoc(full, id) });
  const R = full.research || {};
  for (const s of R.stories || []) if (s.slug) docs.push({ key: `story/${s.slug}.md`, text: storyDoc(full, s) });
  for (const f of R.findings || []) docs.push({ key: `finding/${f.id}.md`, text: findingDoc(full, f) });
  for (const [id, s] of Object.entries(full.sources || {})) docs.push({ key: `source/${id}.md`, text: sourceDoc(id, s) });
  const files = new Set();
  for (const list of Object.values(R.media || {})) for (const m of list || []) if (m && documentType(m.file)) files.add(m.file);
  for (const file of files) docs.push({ key: file, file });
  return docs.map((d) => ({ ...d, key: d.key.slice(0, 120) }));
}

async function sha(text) {
  const buf = await crypto.subtle.digest("SHA-256", typeof text === "string" ? new TextEncoder().encode(text) : text);
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- sync
/** Bring the index up to date. Returns a report; safe to run any time. With force, re-checks even if nothing changed. */
export async function sync(env, { force = false, limit = MAX_CHANGES_PER_RUN } = {}) {
  if (!enabled(env)) return { enabled: false };
  const DB = env.DB;
  const version = await dataVersion(env);
  const synced = await DB.prepare("SELECT value FROM meta WHERE key = 'ai_search_version'").first();
  if (!force && synced && Number(synced.value) === version) return { enabled: true, upToDate: true, version };

  const inst = handle(env);
  try { await inst.items.list({ per_page: 1 }); }
  catch { await env.AI_SEARCH.create({ id: instanceName(env) }); } // first run: the Worker makes its own instance

  const { full } = await fullBundle(env);
  const want = documents(full);
  const have = new Map((await DB.prepare("SELECT key, item_id, hash FROM ai_search_items").all()).results.map((r) => [r.key, r]));
  let changes = 0, uploaded = 0, removed = 0, skipped = 0, failed = 0;
  const wantKeys = new Set();

  for (const d of want) {
    let body = d.text, ext = null, contentType = "text/markdown", hash;
    if (d.file) {
      const obj = env.MEDIA && await env.MEDIA.get(d.file);
      if (!obj) { skipped++; continue; }
      const h = new Headers();
      if (obj.writeHttpMetadata) obj.writeHttpMetadata(h);
      contentType = (h.get("Content-Type") || "").split(";")[0].trim();
      ext = DOC_TYPES[contentType] || (documentType(d.file) === "report" ? "md" : null);
      if (!ext) { skipped++; continue; } // photographs and scans: the agents read those themselves
      body = await new Response(obj.body).arrayBuffer();
      if (body.byteLength > DOC_LIMIT) { skipped++; continue; }
    }
    const key = ext ? `${d.key}.${ext}` : d.key;
    wantKeys.add(key);
    hash = await sha(body);
    const cur = have.get(key);
    if (cur && cur.hash === hash) continue;
    if (changes >= limit) continue;
    changes++;
    try {
      if (cur && cur.item_id) await inst.items.delete(cur.item_id).catch(() => null);
      const res = await inst.items.upload(key, typeof body === "string" ? body : new Blob([body], { type: contentType }));
      await DB.prepare("INSERT INTO ai_search_items (key, item_id, hash, indexed_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET item_id = excluded.item_id, hash = excluded.hash, indexed_at = excluded.indexed_at")
        .bind(key, res && res.id ? res.id : null, hash, now()).run();
      uploaded++;
    } catch (e) { failed++; console.error("ai-search upload", key, e && e.message); }
  }
  for (const [key, row] of have) {
    if (wantKeys.has(key) || changes >= limit) continue;
    changes++;
    try {
      if (row.item_id) await inst.items.delete(row.item_id).catch(() => null);
      await DB.prepare("DELETE FROM ai_search_items WHERE key = ?").bind(key).run();
      removed++;
    } catch (e) { failed++; console.error("ai-search delete", key, e && e.message); }
  }
  const done = changes < limit && !failed;
  if (done) await DB.prepare("INSERT INTO meta (key, value) VALUES ('ai_search_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(version)).run();
  await DB.prepare("INSERT INTO meta (key, value) VALUES ('ai_search_synced_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(now()).run();
  return { enabled: true, version, documents: wantKeys.size, uploaded, removed, skipped, failed, more: !done };
}

export async function status(env) {
  const row = (k) => env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(k).first().then((r) => (r ? r.value : null));
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM ai_search_items").first().catch(() => ({ n: 0 }));
  return { enabled: enabled(env), instance: enabled(env) ? instanceName(env) : null, indexed: n.n, synced_version: await row("ai_search_version"),
    data_version: await dataVersion(env), synced_at: await row("ai_search_synced_at") };
}

// ---------------------------------------------------------------- searching, as one caller sees it
/** Which record an index key is, or null. */
export function recordOf(key) {
  const k = String(key || "").replace(/^\/+/, "");
  let m;
  if ((m = /^(person|story|finding|source)\/(.+)\.md$/.exec(k))) return { kind: m[1], id: m[2] };
  if ((m = /^((?:attachments|reports)\/[\w-]+)\.\w+$/.exec(k))) return { kind: "document", id: m[1] };
  return null;
}

/** The record as `b` (a scoped bundle) shows it: {title, person?, snippetOk} or null when the caller may not see it. */
function visibleAs(b, r) {
  const R = b.research || {}, v = b.scope.view;
  if (r.kind === "person") {
    const id = followAlias(b.aliases, r.id);
    if (!detailsVisible(b, id)) return null;
    return { id, title: b.people[id].name, person: id, snippetOk: v.notes && v.sources && v.research && v.media };
  }
  if (r.kind === "story") { const s = (R.stories || []).find((x) => x.slug === r.id); return s && { title: s.title, snippetOk: true }; }
  if (r.kind === "finding") { const f = (R.findings || []).find((x) => String(x.id) === r.id); return f && { title: f.claim || f.kind || `Finding ${f.id}`, person: f.person || undefined, snippetOk: true }; }
  if (r.kind === "source") { const s = v.sources && (b.sources || {})[r.id]; return s && { title: s.title || r.id, snippetOk: true }; }
  if (r.kind === "document") {
    for (const [pid, list] of Object.entries(R.media || {})) {
      const m = (list || []).find((x) => x && x.file === r.id);
      if (m) return { title: m.caption || (documentType(r.id) === "report" ? "Report" : "Attachment"), person: pid, snippetOk: true };
    }
  }
  return null;
}

/**
 * Search the index and keep only what `b` shows. Returns {available, results:[{kind, id, title, person?, score,
 * snippet?}]}, best first, one result per record.
 */
export async function semanticSearch(env, b, query, { kinds, limit = 10 } = {}) {
  const q = String(query || "").trim();
  if (!enabled(env)) return { available: false, results: [] };
  if (!q) return { available: true, results: [] };
  const n = Math.max(1, Math.min(25, +limit || 10));
  let res;
  try {
    res = await handle(env).search({ messages: [{ role: "user", content: q.slice(0, 1000) }], ai_search_options: { retrieval: { max_num_results: Math.min(50, n * 4) } } });
  } catch (e) {
    console.error("ai-search search", e && e.message);
    return { available: false, results: [] };
  }
  const best = new Map();
  for (const ch of (res && res.chunks) || []) {
    const r = recordOf(ch.item && ch.item.key);
    if (!r || (kinds && kinds.length && !kinds.includes(r.kind))) continue;
    const seen = visibleAs(b, r);
    if (!seen) continue;
    const id = seen.id || r.id, k = `${r.kind}|${id}`;
    const prev = best.get(k);
    if (prev && prev.score >= (ch.score || 0)) continue;
    best.set(k, { kind: r.kind, id, title: seen.title, person: seen.person, score: Math.round((ch.score || 0) * 1000) / 1000,
      snippet: seen.snippetOk ? String(ch.text || "").replace(/\s+/g, " ").trim().slice(0, 400) : undefined });
  }
  const results = [...best.values()].sort((x, y) => y.score - x.score).slice(0, n);
  const { full } = await fullBundle(env);
  return { available: true, results: scrubFor(results, full, b) };
}
