// The research sites list (Admin → Research sites): the genealogy sites every research agent prefers, with notes on
// how to search each, and optional credentials for sites with an API key or HTTP sign-in. Agents never see a
// credential's value: it is encrypted at rest (worker/secrets.js) and added to requests inside web_fetch.
//
//   GET    /api/research-sites                 the list (editors and agents): has_credential, never a value
//   POST   /api/research-sites                 add a site (owner)
//   PUT    /api/research-sites/:id             edit a site, or {enabled} to switch it on or off (owner)
//   DELETE /api/research-sites/:id             remove a site and its credential (owner)
//   PUT    /api/research-sites/:id/credential  {kind: header, name, value} | {kind: query, name, value} |
//                                              {kind: basic, username, password}   set or replace (owner)
//   DELETE /api/research-sites/:id/credential  remove it (owner)
//
// Every change goes to the change log (entity_type "research_site"), so it shows in Admin → Audit history. The log
// records the site and the credential's kind, never its value.
import { can } from "./auth.js";
import { fail, json } from "./http.js";
import { J, now, audit } from "./db.js";
import { encryptSecret, keyConfigured, KeyMissingError, KEY_HELP } from "./secrets.js";
import { ACCESS, QUALITY, CRED_KINDS, listSites, normDomain } from "./agent/sites.js";
import { S } from "../strings/index.ts";

const NO_STORE = { "Cache-Control": "private, no-store" };
const owner = (c) => { if (!can.admin(c.access)) fail(403, S.api.sites.ownerOnly); };
const actorKind = (c) => (c.access.kind === "agent" ? "agent" : "person");
const mayRead = (a) => a.isOwner || a.grants.some((g) => can.review(g)) || (a.kind === "agent" && a.grants.length > 0);
const isUrl = (s) => /^https?:\/\/[^\s/]+\.[^\s]+$/i.test(String(s || ""));
const list = (v) => (Array.isArray(v) ? v : String(v || "").split(/[,\n]/)).map((x) => String(x).trim()).filter(Boolean);
const text = (v, max) => String(v ?? "").trim().slice(0, max);
/** A site as the audit log keeps it (no credential fields). */
const snapshot = ({ has_credential, credential, ...s }) => s;

/** Validate a site body, merged over `cur` for an edit. Returns the row to write. */
export function cleanSite(d, cur = null) {
  const v = { ...(cur || {}) };
  const has = (k) => d[k] !== undefined;
  if (!cur || has("name")) { v.name = text(d.name, 120); if (!v.name) fail(400, S.api.sites.nameRequired); }
  if (!cur || has("url")) { v.url = text(d.url, 500); if (!isUrl(v.url)) fail(400, S.api.sites.urlInvalid); }
  if (has("search_url")) {
    v.search_url = text(d.search_url, 1000);
    if (v.search_url && !isUrl(v.search_url)) fail(400, S.api.sites.searchUrlInvalid);
    if (v.search_url && !/\{(given|surname|birth_year|place)\}/.test(v.search_url)) fail(400, S.api.sites.searchUrlPlaceholder);
  }
  if (!cur || has("domains") || has("url")) {
    let doms = has("domains") ? list(d.domains).map(normDomain) : (cur ? cur.domains : []);
    if (!doms.length) doms = [normDomain(new URL(v.url).hostname).replace(/^www\./, "")];
    doms = [...new Set(doms)].slice(0, 20);
    const bad = doms.find((x) => !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(x));
    if (bad) fail(400, S.api.sites.domainInvalid(bad));
    v.domains = doms;
  }
  if (!cur || has("coverage")) v.coverage = text(d.coverage, 1000);
  if (!cur || has("record_types")) v.record_types = [...new Set(list(d.record_types).map((x) => x.toLowerCase().replace(/\s+/g, "-").slice(0, 40)))].slice(0, 20);
  if (!cur || has("access")) { v.access = d.access || "open"; if (!ACCESS.includes(v.access)) fail(400, S.api.sites.accessInvalid(ACCESS)); }
  if (!cur || has("source_quality")) { v.source_quality = d.source_quality || "indexes"; if (!QUALITY.includes(v.source_quality)) fail(400, S.api.sites.qualityInvalid(QUALITY)); }
  if (!cur || has("api")) v.api = text(d.api, 500);
  if (!cur || has("agent_notes")) v.agent_notes = text(d.agent_notes, 1500);
  if (!cur || has("enabled")) v.enabled = d.enabled === undefined ? true : !!d.enabled;
  if (has("sort")) { const n = parseInt(d.sort, 10); if (!Number.isFinite(n)) fail(400, S.api.sites.sortNumber); v.sort = n; }
  return v;
}

const slug = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

async function one(env, id) {
  return (await listSites(env)).find((s) => s.id === id) || null;
}

export async function listRoute(c) {
  if (!mayRead(c.access)) fail(403, S.api.sites.readersOnly);
  const sites = await listSites(c.env);
  const out = { sites };
  if (c.access.isOwner) { out.key_configured = keyConfigured(c.env); if (!out.key_configured) out.key_help = KEY_HELP; }
  return json(out, 200, NO_STORE);
}

export async function createRoute(c, d) {
  owner(c);
  const v = cleanSite(d || {});
  const id = d.id ? String(d.id) : slug(v.name);
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(id)) fail(400, S.api.sites.idInvalid);
  if (await one(c.env, id)) fail(409, S.api.sites.idTaken(id));
  const max = await c.env.DB.prepare("SELECT COALESCE(MAX(sort), 0) AS m FROM research_sites").first();
  const t = now(), by = c.access.principal;
  const sort = v.sort ?? (max.m + 10);
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO research_sites (id, name, url, search_url, domains, coverage, record_types, access, source_quality, api, agent_notes, enabled, sort, created_by, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, v.name, v.url, v.search_url || null, J(v.domains), v.coverage, J(v.record_types), v.access, v.source_quality, v.api, v.agent_notes, v.enabled ? 1 : 0, sort, by, t, t, by),
    audit(c.env, { actor: by, actorKind: actorKind(c), entityType: "research_site", entityId: id, op: "create", after: { id, ...v, sort } }),
  ]);
  return json({ site: await one(c.env, id) }, 201);
}

export async function updateRoute(c, id, d) {
  owner(c);
  const cur = await one(c.env, id);
  if (!cur) fail(404, S.api.sites.noSuch);
  const v = cleanSite(d || {}, cur);
  const before = snapshot(cur), after = snapshot({ ...cur, ...v });
  const changed = Object.keys(after).filter((k) => !["updated_at", "updated_by"].includes(k) && JSON.stringify(after[k]) !== JSON.stringify(before[k]));
  if (!changed.length) return json({ site: cur });
  const op = changed.length === 1 && changed[0] === "enabled" ? (v.enabled ? "enable" : "disable") : "update";
  const t = now(), by = c.access.principal;
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE research_sites SET name = ?, url = ?, search_url = ?, domains = ?, coverage = ?, record_types = ?, access = ?, source_quality = ?, api = ?, agent_notes = ?, enabled = ?, sort = ?, updated_at = ?, updated_by = ? WHERE id = ?")
      .bind(v.name, v.url, v.search_url || null, J(v.domains), v.coverage, J(v.record_types), v.access, v.source_quality, v.api, v.agent_notes, v.enabled ? 1 : 0, v.sort, t, by, id),
    audit(c.env, { actor: by, actorKind: actorKind(c), entityType: "research_site", entityId: id, op, before, after: { ...after, updated_at: t, updated_by: by } }),
  ]);
  return json({ site: await one(c.env, id) });
}

export async function deleteRoute(c, id) {
  owner(c);
  const cur = await one(c.env, id);
  if (!cur) fail(404, S.api.sites.noSuch);
  const by = c.access.principal;
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM research_site_credentials WHERE site_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM research_sites WHERE id = ?").bind(id),
    audit(c.env, { actor: by, actorKind: actorKind(c), entityType: "research_site", entityId: id, op: "delete", before: { ...snapshot(cur), credential: cur.credential ? { kind: cur.credential.kind } : null } }),
  ]);
  return json({ ok: true });
}

const FORBIDDEN_HEADERS = new Set(["host", "cookie", "content-length", "content-type", "connection", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authorization"]);
const oneLine = (s) => !/[\r\n\0]/.test(s);

/** The secret to encrypt for a credential body; throws on anything malformed. */
export function cleanCredential(d) {
  const kind = d && d.kind;
  if (!CRED_KINDS.includes(kind)) fail(400, S.api.sites.credentialKind(CRED_KINDS));
  const s = (k) => String((d && d[k]) ?? "");
  if (kind === "header") {
    const name = s("name").trim(), value = s("value");
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(name)) fail(400, S.api.sites.headerName);
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) fail(400, S.api.sites.headerForbidden(name));
    if (!value || value.length > 4000 || !oneLine(value)) fail(400, S.api.sites.headerValue);
    return { kind, secret: { name, value } };
  }
  if (kind === "query") {
    const name = s("name").trim(), value = s("value");
    if (!/^[A-Za-z0-9_.~-]{1,64}$/.test(name)) fail(400, S.api.sites.queryName);
    if (!value || value.length > 2000 || !oneLine(value)) fail(400, S.api.sites.queryValue);
    return { kind, secret: { name, value } };
  }
  const username = s("username"), password = s("password");
  if (!username || username.includes(":") || !oneLine(username) || username.length > 200) fail(400, S.api.sites.usernameRequired);
  if (!password || !oneLine(password) || password.length > 1000) fail(400, S.api.sites.passwordRequired);
  return { kind, secret: { username, password } };
}

export async function setCredentialRoute(c, id, d) {
  owner(c);
  const cur = await one(c.env, id);
  if (!cur) fail(404, S.api.sites.noSuch);
  const { kind, secret } = cleanCredential(d);
  if (!keyConfigured(c.env)) fail(503, new KeyMissingError().message, { setup: KEY_HELP });
  let blob;
  try { blob = await encryptSecret(c.env, id, secret); }
  catch (e) { if (e instanceof KeyMissingError) fail(503, e.message, { setup: KEY_HELP }); throw e; }
  const t = now(), by = c.access.principal;
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO research_site_credentials (site_id, kind, secret, updated_at, updated_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT(site_id) DO UPDATE SET kind = excluded.kind, secret = excluded.secret, updated_at = excluded.updated_at, updated_by = excluded.updated_by")
      .bind(id, kind, blob, t, by),
    audit(c.env, { actor: by, actorKind: actorKind(c), entityType: "research_site", entityId: id, op: cur.credential ? "credential-replace" : "credential-set",
      before: cur.credential ? { name: cur.name, credential: { kind: cur.credential.kind } } : undefined, after: { name: cur.name, credential: { kind } }, reason: `credential for ${cur.name}` }),
  ]);
  return json({ site: await one(c.env, id) });
}

export async function removeCredentialRoute(c, id) {
  owner(c);
  const cur = await one(c.env, id);
  if (!cur) fail(404, S.api.sites.noSuch);
  if (!cur.credential) fail(404, S.api.sites.noCredential);
  const by = c.access.principal;
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM research_site_credentials WHERE site_id = ?").bind(id),
    audit(c.env, { actor: by, actorKind: actorKind(c), entityType: "research_site", entityId: id, op: "credential-remove", before: { name: cur.name, credential: { kind: cur.credential.kind } }, reason: `credential for ${cur.name}` }),
  ]);
  return json({ site: await one(c.env, id) });
}

/** Route /api/research-sites… (null when the path isn't one of these). */
export async function route(c, p, m, body) {
  let r;
  if (p === "/api/research-sites" && m === "GET") return listRoute(c);
  if (p === "/api/research-sites" && m === "POST") return createRoute(c, await body(c));
  if ((r = p.match(/^\/api\/research-sites\/([\w-]+)$/))) {
    if (m === "PUT") return updateRoute(c, r[1], await body(c));
    if (m === "DELETE") return deleteRoute(c, r[1]);
  }
  if ((r = p.match(/^\/api\/research-sites\/([\w-]+)\/credential$/))) {
    if (m === "PUT") return setCredentialRoute(c, r[1], await body(c));
    if (m === "DELETE") return removeCredentialRoute(c, r[1]);
  }
  return null;
}
