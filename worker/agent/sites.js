// The research sites list as the agents use it (#44 and the shared list): a compact summary for the first message,
// full details on request, and credentials applied server-side when an agent fetches a page on a listed site.
// Plain functions, shared by the site Worker (which writes the summary into a run's first message) and the agents
// Worker (whose web_fetch applies credentials). The model never sees a credential's value.
import { parse } from "../db.js";
import { decryptSecret } from "../secrets.js";

export const ACCESS = ["open", "free-account", "subscription", "institution"];
export const QUALITY = ["original-images", "indexes", "compiled"];
export const CRED_KINDS = ["header", "query", "basic"];
/** Upper bound for the summary in a run's first message (characters). */
export const SUMMARY_MAX = 4000;

const COLS = "id, name, url, search_url, domains, coverage, record_types, access, source_quality, api, agent_notes, enabled, sort, created_by, created_at, updated_at, updated_by";

/** A research_sites row in API shape. Never carries credential data. */
export function siteOut(r, cred) {
  return {
    id: r.id, name: r.name, url: r.url, search_url: r.search_url || "", domains: parse(r.domains, []), coverage: r.coverage || "",
    record_types: parse(r.record_types, []), access: r.access, source_quality: r.source_quality, api: r.api || "", agent_notes: r.agent_notes || "",
    enabled: !!r.enabled, sort: r.sort, created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at, updated_by: r.updated_by || null,
    has_credential: !!cred,
    credential: cred ? { kind: cred.kind, updated_at: cred.updated_at, updated_by: cred.updated_by } : null,
  };
}

/** Every site (or only enabled ones), with whether each has a credential: kind and dates only, never the secret. */
export async function listSites(env, { enabledOnly = false } = {}) {
  const rows = (await env.DB.prepare(`SELECT ${COLS} FROM research_sites ${enabledOnly ? "WHERE enabled = 1 " : ""}ORDER BY sort, name`).all().catch(() => ({ results: [] }))).results;
  const creds = (await env.DB.prepare("SELECT site_id, kind, updated_at, updated_by FROM research_site_credentials").all().catch(() => ({ results: [] }))).results;
  const byId = Object.fromEntries(creds.map((c) => [c.site_id, c]));
  return rows.map((r) => siteOut(r, byId[r.id]));
}

const host = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/\.$/, ""); } catch { return ""; } };
const clean = (d) => String(d || "").trim().toLowerCase().replace(/^\*\./, "").replace(/^https?:\/\//, "").replace(/[/:].*$/, "").replace(/\.$/, "");
export const normDomain = clean;

/** Whether `hostname` is one of `domains` or a subdomain of one. */
export function hostMatches(hostname, domains) {
  const h = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return !!h && (domains || []).some((d) => { const x = clean(d); return x && (h === x || h.endsWith(`.${x}`)); });
}

/** The listed site a URL belongs to (the most specific domain wins), or null. */
export function siteForUrl(sites, url) {
  const h = host(url);
  let best = null, len = -1;
  for (const s of sites || []) for (const d of s.domains || []) {
    const x = clean(d);
    if (x && (h === x || h.endsWith(`.${x}`)) && x.length > len) { best = s; len = x.length; }
  }
  return best;
}

const short = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
const firstSentence = (s) => { const t = String(s || "").replace(/\s+/g, " ").trim(); const m = t.match(/^(.+?[.!?])(\s|$)/); return m ? m[1] : t; };

/**
 * The compact list for a run's first message: name, main domain, access, whether a credential is available, and a
 * one-line note, grouped open sites first. Stays under `max` characters: notes get shorter, then the tail is cut with
 * a pointer to the research_sites tool.
 */
export function sitesSummary(sites, { max = SUMMARY_MAX } = {}) {
  const on = (sites || []).filter((s) => s.enabled !== false);
  if (!on.length) return "Research sites: none are listed. Use well-known free archives and indexes, and cite only pages you read.";
  const head = "Research sites (the owner's list): prefer these and follow their notes; research_sites gives full details, search URL templates, and filters by record type. Each line: name · domain · credential (yes: web_fetch signs in for you; no: on a subscription or institution site, log the search as inconclusive and leave the owner a to-do) · note.";
  const order = (s) => ACCESS.indexOf(s.access);
  const sorted = [...on].sort((a, b) => order(a) - order(b) || (a.sort || 0) - (b.sort || 0));
  const GROUP = { open: "Open:", "free-account": "Free account:", subscription: "Subscription:", institution: "Institution:" };
  const line = (s, n) => {
    const note = n ? short(firstSentence(s.agent_notes), n) : "";
    return `- ${String(s.name).replace(/\s*\([^)]*\)\s*$/, "")} · ${(s.domains || [])[0] || host(s.url)} · ${s.has_credential ? "credential: yes" : "no"}${note ? ` · ${note}` : ""}`;
  };
  const render = (list, n, tail) => {
    const out = [head];
    let g = null;
    for (const s of list) { if (s.access !== g) { g = s.access; out.push(GROUP[g] || `${g}:`); } out.push(line(s, n)); }
    if (tail) out.push(tail);
    return out.join("\n");
  };
  for (const n of [100, 70, 50, 35, 0]) {
    const out = render(sorted, n);
    if (out.length <= max) return out;
  }
  // too many even without notes: as many as fit, then a pointer to the tool
  let k = sorted.length;
  while (k > 0 && render(sorted.slice(0, k), 0, `…and ${sorted.length - k} more: call research_sites to see them.`).length > max) k--;
  return render(sorted.slice(0, k), 0, `…and ${sorted.length - k} more: call research_sites to see them.`);
}

/** The research_sites tool: full details of enabled sites, optionally filtered by record type, access or a word. */
export function sitesDetail(sites, { record_type, access, query } = {}) {
  const q = String(query || "").toLowerCase().trim();
  const hits = (sites || []).filter((s) => s.enabled !== false)
    .filter((s) => !record_type || (s.record_types || []).includes(record_type))
    .filter((s) => !access || s.access === access)
    .filter((s) => !q || [s.name, s.coverage, s.agent_notes, ...(s.domains || [])].join(" ").toLowerCase().includes(q));
  return {
    sites: hits.map((s) => ({ name: s.name, url: s.url, search_url: s.search_url || undefined, domains: s.domains, coverage: s.coverage, record_types: s.record_types,
      access: s.access, source_quality: s.source_quality, api: s.api || undefined, notes: s.agent_notes || undefined, credential_available: !!s.has_credential })),
    note: "search_url placeholders: {given} {surname} {birth_year} {place}; fill them in and fetch it. With credential_available, web_fetch signs in to that site automatically; without one, a subscription or institution site's records are a to-do for the owner.",
  };
}

// ---------------------------------------------------------------- credentials at fetch time (agents Worker)

/** Enabled sites that have a credential, decrypted. Sites whose credential doesn't decrypt are skipped (and reported). */
export async function loadCredentials(env, { onError = () => {} } = {}) {
  const rows = (await env.DB.prepare("SELECT s.id, s.name, s.domains, c.kind, c.secret FROM research_sites s JOIN research_site_credentials c ON c.site_id = s.id WHERE s.enabled = 1").all().catch(() => ({ results: [] }))).results;
  const out = [];
  for (const r of rows) {
    try { out.push({ id: r.id, name: r.name, domains: parse(r.domains, []), kind: r.kind, secret: await decryptSecret(env, r.id, r.secret) }); }
    catch (e) { onError(r, e); }
  }
  return out;
}

/** Add one credential to a request: a header, a query parameter, or HTTP Basic auth. Returns [url, headers]. */
export function withCredential(url, headers, cred) {
  const u = new URL(url), h = new Headers(headers || {});
  const s = cred.secret || {};
  if (cred.kind === "header") h.set(s.name, s.value);
  else if (cred.kind === "query") u.searchParams.set(s.name, s.value);
  else if (cred.kind === "basic") {
    const bytes = new TextEncoder().encode(`${s.username}:${s.password}`);
    let bin = ""; for (const x of bytes) bin += String.fromCharCode(x);
    h.set("Authorization", `Basic ${btoa(bin)}`);
  }
  return [u.href, h];
}

/**
 * A fetch for agents/webfetch's `fetch` option. The library follows redirects itself, one hop per call, so each hop
 * is checked here on its own: the credential of the site the *requested* URL belongs to is added only to https hops
 * whose host is one of that site's domains. A redirect anywhere else is followed without it. `onUse(site)` is called
 * once a credential has been sent.
 */
/** Remove a credential's secret parts from text the model or the logs will see (a site may echo a key back, e.g. in
 * a redirect URL or on the page). Also strips each value's URL-encoded and JSON-escaped forms. */
export function scrubSecrets(text, cred) {
  if (text == null || !cred) return text;
  const s = cred.secret || {};
  const parts = [s.value, s.password, s.username && s.password ? btoa(`${s.username}:${s.password}`) : null].filter((x) => x && String(x).length >= 4);
  let out = String(text);
  for (const x of parts) for (const v of new Set([String(x), encodeURIComponent(String(x)), JSON.stringify(String(x)).slice(1, -1)])) out = out.split(v).join("[credential]");
  return out;
}

export function credentialedFetch({ requested, creds, baseFetch = fetch, onUse = () => {} }) {
  const site = siteForUrl(creds, requested);
  const startsHttps = /^https:/i.test(String(requested));
  return async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    let u;
    try { u = new URL(url); } catch { return baseFetch(input, init); }
    if (site && startsHttps && u.protocol === "https:" && hostMatches(u.hostname, site.domains)) {
      const [href, headers] = withCredential(u.href, init.headers, site);
      onUse(site);
      return baseFetch(href, { ...init, headers });
    }
    return baseFetch(url, init);
  };
}
