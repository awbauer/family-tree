import { readTree } from "./storage.js";

// Small helpers over the D1 binding. Every write goes through `write()`, which records an audit row in `changes`
// and bumps meta.data_version in the same batch, so readers can cache derived data per version.

export const now = () => new Date().toISOString();
export const J = (v) => JSON.stringify(v);
export const parse = (s, fallback = null) => {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};

export async function dataVersion(env) {
  const r = await env.DB.prepare("SELECT value FROM meta WHERE key = 'data_version'").first();
  return r ? Number(r.value) : 0;
}

export async function meta(env, key) {
  const r = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first();
  return r ? r.value : null;
}

// A failed precondition aborts every statement in a D1 batch, including audit rows.
export const guard = (env, condition, ...args) => env.DB.prepare(`INSERT INTO _guard (x) SELECT NULL WHERE ${condition}`).bind(...args);

export const bumpVersion = (env) =>
  env.DB.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'data_version'");

export const audit = (env, { actor, actorKind, entityType, entityId, op, before, after, reason, proposalId }) =>
  env.DB.prepare(
    "INSERT INTO changes (at, actor, actor_kind, entity_type, entity_id, op, before, after, reason, proposal_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(now(), actor, actorKind, entityType, String(entityId), op,
    before === undefined ? null : J(before), after === undefined ? null : J(after), reason || null, proposalId || null);

/** Run statements atomically together with a data_version bump. */
export async function write(env, statements) {
  return env.DB.batch([...statements, bumpVersion(env)]);
}

/** Load everything derive.js needs: {raw, research, places}. */
export async function loadState(env) {
  const q = (sql) => env.DB.prepare(sql).all().then((r) => r.results);
  const [tree, config, findings, statuses, stories, log, todos] = await Promise.all([
    readTree(env), q("SELECT key, value FROM config"),
    q("SELECT id, version, data FROM findings ORDER BY id"), q("SELECT person_id, data FROM statuses"),
    q("SELECT slug, data FROM stories ORDER BY rowid"), q("SELECT id, data FROM research_log ORDER BY id"),
    q("SELECT * FROM todos ORDER BY id"),
  ]);
  // AI-written profiles (migration 0003). Optional, so a database that hasn't been migrated yet still loads.
  const profiles = await q("SELECT person_id, text, generated_at, model FROM profiles").catch(() => []);
  const cfg = Object.fromEntries(config.map((r) => [r.key, parse(r.value)]));
  const open = todos.filter((t) => !["done", "wont_do"].includes(t.status));
  const closed = todos.filter((t) => ["done", "wont_do"].includes(t.status));
  const research = {
    site: cfg.site || {}, home_person: cfg.home_person, core_people: cfg.core_people || [],
    branches: cfg.branches || [], place_rules: cfg.place_rules || [], overrides: cfg.overrides || {},
    duplicates: cfg.duplicates || [], methodology: cfg.methodology || "", context: cfg.context || [],
    people_status: Object.fromEntries(statuses.map((r) => [r.person_id, parse(r.data)])),
    findings: findings.map((r) => Object.assign({ id: r.id, version: r.version }, parse(r.data))),
    stories: stories.map((r) => parse(r.data)),
    research_log: log.map((r) => Object.assign({ id: r.id }, parse(r.data))),
    todo: open.map(todoOut), todo_done: closed.map(todoOut),
    media: cfg.media_map || {},
  };
  return {
    raw: { people: tree.people, families: tree.families, sources: tree.sources, media: tree.media },
    research, places: cfg.places || {}, aliases: cfg.aliases || {}, profiles,
  };
}

/** The API/app shape of a to-do row (keeps the old research.json field names). */
export function todoOut(t) {
  return {
    id: t.id, person: t.person_id || null, tree: t.tree_id || null, task: t.task, where: t.location || "",
    priority: t.priority, status: t.status, assignee: t.assignee || null, branch: t.branch || null,
    outcome: t.outcome || "", created_at: t.created_at, created_by: t.created_by,
    updated_at: t.updated_at, updated_by: t.updated_by, closed_at: t.closed_at || null, version: t.version,
  };
}
