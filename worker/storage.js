// The storage layer: reads and writes the tree in either layout.
//   'working'  people / families / sources / media rows hold the app's working model (the original layout)
//   'gedcomx'  people hold GEDCOM X Persons, sources and media hold SourceDescriptions, and families are stored as
//              GEDCOM X relationships (Couple, ParentChild, ft:FamilyGroup) in `relationships`
// Everything above this layer (derive, ops, scope, views, the change log) sees the working model either way;
// worker/gedcomx.js converts losslessly. upgrade() moves a database from 'working' to 'gedcomx' in one transaction.
import * as GX from "./gedcomx.js";

const parse = (s, d = null) => { if (s == null) return d; try { return JSON.parse(s); } catch { return d; } };
const J = (v) => JSON.stringify(v);

export async function mode(env) {
  const r = await env.DB.prepare("SELECT value FROM meta WHERE key = 'storage'").first().catch(() => null);
  return r && r.value === "gedcomx" ? "gedcomx" : "working";
}

/** A family's version token in gedcomx storage: changes whenever any of its relationship rows is written. */
export const familyToken = (rows) => `${rows.length}:${rows.reduce((a, r) => a + r.version, 0)}:${rows.reduce((a, r) => Math.max(a, r.version), 0)}`;
const tokenSql = "SELECT COUNT(*) || ':' || COALESCE(SUM(version), 0) || ':' || COALESCE(MAX(version), 0) FROM relationships WHERE family = ?";

/** The whole tree in the working model, with each record's version (for optimistic writes). */
export async function readTree(env) {
  const q = (sql) => env.DB.prepare(sql).all().then((r) => r.results);
  const m = await mode(env);
  const versions = {};
  if (m === "working") {
    const [people, families, sources, media] = await Promise.all([q("SELECT id, data, version FROM people"), q("SELECT id, data, version FROM families"), q("SELECT id, data, version FROM sources"), q("SELECT id, data, version FROM media")]);
    const by = (rows, t) => Object.fromEntries(rows.map((r) => { versions[`${t}:${r.id}`] = r.version; return [r.id, parse(r.data)]; }));
    return { mode: m, people: by(people, "person"), families: by(families, "family"), sources: by(sources, "source"), media: by(media, "media"), versions };
  }
  const [people, rels, sources, media] = await Promise.all([q("SELECT id, data, version FROM people"), q("SELECT id, family, data, version FROM relationships"), q("SELECT id, data, version FROM sources"), q("SELECT id, data, version FROM media")]);
  const tree = GX.fromGx({ persons: people.map((r) => parse(r.data)), relationships: rels.map((r) => parse(r.data)), sourceDescriptions: [...sources, ...media].map((r) => parse(r.data)) });
  for (const r of people) versions[`person:${r.id}`] = r.version;
  for (const r of sources) versions[`source:${r.id}`] = r.version;
  const byFam = new Map();
  for (const r of rels) { if (!byFam.has(r.family)) byFam.set(r.family, []); byFam.get(r.family).push(r); }
  for (const [f, rows] of byFam) versions[`family:${f}`] = familyToken(rows);
  return { mode: m, ...tree, versions };
}

const guard = (env, cond, ...args) => env.DB.prepare(`INSERT INTO _guard (x) SELECT NULL WHERE ${cond}`).bind(...args);
const TABLE = { person: "people", family: "families", source: "sources", status: "statuses" };
const keyColumn = (type) => type === "status" ? "person_id" : "id";
const toStored = (m, type, v) => (m === "working" ? v : type === "person" ? GX.personToGx(v) : type === "source" ? GX.sourceToGx(v) : v);

/**
 * Statements that write one touched record (x = {type, id, before, after}) with a version check. Returns
 * {statements, versionAfter}. In gedcomx storage a family is written as its set of relationships.
 */
export function writeRecord(env, m, x, versions, t, actor) {
  const st = [];
  if (m === "gedcomx" && x.type === "family") {
    const token = versions[`family:${x.id}`] ?? "0:0:0";
    st.push(guard(env, `(${tokenSql}) != ?`, x.id, token));
    const prevMax = +String(token).split(":")[2] || 0;
    st.push(env.DB.prepare("DELETE FROM relationships WHERE family = ?").bind(x.id));
    if (x.after != null) {
      for (const r of GX.familyToGx(x.after)) {
        st.push(env.DB.prepare("INSERT INTO relationships (id, family, type, person1, person2, data, version, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(r.id, x.id, r.type, r.person1 ? r.person1.resource.slice(1) : null, r.person2 ? r.person2.resource.slice(1) : null, J(r), prevMax + 1, t, actor));
      }
    }
    return { statements: st, versionAfter: x.after == null ? null : prevMax + 1 };
  }
  const tbl = TABLE[x.type], key = keyColumn(x.type);
  const v = versions[`${x.type}:${x.id}`];
  if (x.before == null) {
    st.push(guard(env, `EXISTS (SELECT 1 FROM ${tbl} WHERE ${key} = ?)`, x.id));
    st.push(env.DB.prepare(`INSERT INTO ${tbl} (${key}, data, version, updated_at, updated_by) VALUES (?, ?, 1, ?, ?)`).bind(x.id, J(toStored(m, x.type, x.after)), t, actor));
    return { statements: st, versionAfter: 1 };
  }
  st.push(guard(env, `NOT EXISTS (SELECT 1 FROM ${tbl} WHERE ${key} = ? AND version = ?)`, x.id, v));
  if (x.after == null) st.push(env.DB.prepare(`DELETE FROM ${tbl} WHERE ${key} = ?`).bind(x.id));
  else st.push(env.DB.prepare(`UPDATE ${tbl} SET data = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE ${key} = ?`).bind(J(toStored(m, x.type, x.after)), t, actor, x.id));
  return { statements: st, versionAfter: x.after == null ? null : v + 1 };
}

/**
 * Statements that put one record back to `before`, only if it still holds exactly `after` (content, not version).
 * Throws {conflict: true} when it has changed since.
 */
export async function restoreRecord(env, m, type, id, before, after, t, actor) {
  const st = [];
  if (m === "gedcomx" && type === "family") {
    const rows = (await env.DB.prepare("SELECT data, version FROM relationships WHERE family = ?").bind(id).all()).results;
    const cur = rows.length ? GX.familyFromGx(rows.map((r) => parse(r.data))) : null;
    if (J(canon(cur)) !== J(canon(after))) throw Object.assign(new Error("changed since"), { conflict: true });
    st.push(guard(env, `(${tokenSql}) != ?`, id, familyToken(rows)));
    st.push(env.DB.prepare("DELETE FROM relationships WHERE family = ?").bind(id));
    const next = rows.reduce((a, r) => Math.max(a, r.version), 0) + 1;
    if (before != null) for (const r of GX.familyToGx(before)) {
      st.push(env.DB.prepare("INSERT INTO relationships (id, family, type, person1, person2, data, version, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(r.id, id, r.type, r.person1 ? r.person1.resource.slice(1) : null, r.person2 ? r.person2.resource.slice(1) : null, J(r), next, t, actor));
    }
    return st;
  }
  const tbl = TABLE[type], key = keyColumn(type);
  const stored = (v) => J(toStored(m, type, v));
  if (after == null) {
    st.push(guard(env, `EXISTS (SELECT 1 FROM ${tbl} WHERE ${key} = ?)`, id));
    st.push(env.DB.prepare(`INSERT INTO ${tbl} (${key}, data, version, updated_at, updated_by) VALUES (?, ?, 1, ?, ?)`).bind(id, stored(before), t, actor));
  } else {
    st.push(guard(env, `NOT EXISTS (SELECT 1 FROM ${tbl} WHERE ${key} = ? AND data = ?)`, id, stored(after)));
    if (before == null) st.push(env.DB.prepare(`DELETE FROM ${tbl} WHERE ${key} = ?`).bind(id));
    else st.push(env.DB.prepare(`UPDATE ${tbl} SET data = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE ${key} = ?`).bind(stored(before), t, actor, id));
  }
  return st;
}

/** Order-insensitive form of a record, for comparing a stored family with a logged snapshot. */
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}

/**
 * Move a 'working' database to GEDCOM X storage. Converts every record, proves each converts back exactly, and
 * (unless dryRun) writes everything in one transaction. Returns a report.
 */
export async function upgrade(env, { dryRun = true, actor = "system" } = {}) {
  if ((await mode(env)) === "gedcomx") return { ok: true, already: true };
  const tree = await readTree(env);
  const doc = GX.toGx(tree);
  const back = GX.fromGx(JSON.parse(J(doc)));
  const mismatched = [];
  for (const k of ["people", "families", "sources", "media"]) {
    for (const id of new Set([...Object.keys(tree[k]), ...Object.keys(back[k])])) if (J(canon(tree[k][id] ?? null)) !== J(canon(back[k][id] ?? null))) mismatched.push(`${k}/${id}`);
  }
  const types = {};
  for (const r of doc.relationships) types[r.type.split(/[/#]/).pop()] = (types[r.type.split(/[/#]/).pop()] || 0) + 1;
  const report = { ok: !mismatched.length, dryRun, persons: doc.persons.length, families: Object.keys(tree.families).length, relationships: doc.relationships.length, relationshipTypes: types,
    sourceDescriptions: doc.sourceDescriptions.length, mismatched: mismatched.slice(0, 50) };
  if (mismatched.length || dryRun) return report;
  const t = new Date().toISOString();
  const st = [];
  for (const p of doc.persons) st.push(env.DB.prepare("UPDATE people SET data = ? WHERE id = ?").bind(J(p), p.id));
  for (const sd of doc.sourceDescriptions) st.push(env.DB.prepare(`UPDATE ${sd[GX.FT + "kind"] === "media" ? "media" : "sources"} SET data = ? WHERE id = ?`).bind(J(sd), sd.id));
  const famOf = (r) => r[GX.FT + "family"] || r.id;
  for (const r of doc.relationships) st.push(env.DB.prepare("INSERT INTO relationships (id, family, type, person1, person2, data, version, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)")
    .bind(r.id, famOf(r), r.type, r.person1 ? r.person1.resource.slice(1) : null, r.person2 ? r.person2.resource.slice(1) : null, J(r), t, actor));
  st.push(env.DB.prepare("DELETE FROM families"));
  st.push(env.DB.prepare("UPDATE meta SET value = 'gedcomx' WHERE key = 'storage'"));
  st.push(env.DB.prepare("INSERT INTO changes (at, actor, actor_kind, entity_type, entity_id, op, before, after, reason) VALUES (?, ?, 'person', 'config', 'storage', 'storage-upgrade', ?, ?, ?)")
    .bind(t, actor, J({ storage: "working" }), J({ storage: "gedcomx", relationships: doc.relationships.length }), "Moved to GEDCOM X storage (docs/design/standards.md)"));
  st.push(env.DB.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'data_version'"));
  await env.DB.batch(st);
  return { ...report, written: st.length };
}

/** Load a GEDCOM X document into an EMPTY database, in GEDCOM X storage. Returns counts. */
export async function importDoc(env, doc, { actor = "system", assignFids } = {}) {
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM people").first();
  if (n && n.n) throw Object.assign(new Error("The database already has people. Import only into an empty tree."), { status: 409 });
  const persons = (doc.persons || []).filter((p) => !p.extracted); // record personas are evidence, not the tree
  const tree = GX.fromGx({ ...doc, persons });
  if (assignFids) { for (const p of Object.values(tree.people)) assignFids(p); for (const f of Object.values(tree.families)) assignFids(f); }
  const gx = GX.toGx(tree); // normalised: our family grouping, extensions, fact ids
  const t = new Date().toISOString(), st = [];
  for (const p of gx.persons) st.push(env.DB.prepare("INSERT INTO people (id, data, version, updated_at, updated_by) VALUES (?, ?, 1, ?, ?)").bind(p.id, J(p), t, actor));
  for (const sd of gx.sourceDescriptions) st.push(env.DB.prepare(`INSERT INTO ${sd[GX.FT + "kind"] === "media" ? "media" : "sources"} (id, data, version, updated_at, updated_by) VALUES (?, ?, 1, ?, ?)`).bind(sd.id, J(sd), t, actor));
  for (const r of gx.relationships) st.push(env.DB.prepare("INSERT INTO relationships (id, family, type, person1, person2, data, version, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)")
    .bind(r.id, r[GX.FT + "family"] || r.id, r.type, r.person1 ? r.person1.resource.slice(1) : null, r.person2 ? r.person2.resource.slice(1) : null, J(r), t, actor));
  st.push(env.DB.prepare("INSERT INTO meta (key, value) VALUES ('storage', 'gedcomx') ON CONFLICT(key) DO UPDATE SET value = 'gedcomx'"));
  st.push(env.DB.prepare("INSERT INTO meta (key, value) VALUES ('source_of_truth', 'app') ON CONFLICT(key) DO UPDATE SET value = 'app'"));
  st.push(env.DB.prepare("INSERT OR IGNORE INTO trees (id, name, definition, created_at, updated_at) VALUES ('all', 'Everyone', '{\"branches\":[\"*\"]}', ?, ?)").bind(t, t));
  st.push(env.DB.prepare("INSERT INTO changes (at, actor, actor_kind, entity_type, entity_id, op, after, reason) VALUES (?, ?, 'person', 'config', 'import', 'import', ?, 'GEDCOM X import')")
    .bind(t, actor, J({ persons: gx.persons.length, relationships: gx.relationships.length, sources: gx.sourceDescriptions.length })));
  st.push(env.DB.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'data_version'"));
  await env.DB.batch(st);
  return { persons: gx.persons.length, relationships: gx.relationships.length, sourceDescriptions: gx.sourceDescriptions.length };
}
