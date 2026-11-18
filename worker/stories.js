// Editing family stories directly (editors). Members and agents still suggest stories through research batches
// (`stories`, `story_updates`), which an editor approves; this is the editor's own pen.
//
//   POST   /api/stories              {tree, title, body, people, sources, era?, slug?, reason?}   write a new story
//   PUT    /api/stories/:slug        {tree, version?, title?, body?, people?, sources?, era?, reason?}   revise one
//   DELETE /api/stories/:slug?tree=  {reason?}                                                       remove one
//
// A story is edited under the same rule the tree's views show it by: everyone it's about and everyone its body links
// must be visible in full to the editor, before and after the change. Every change is one batch in the change log
// (entity_type "story"), so history shows it and revert_change / POST /api/changes/:batch/revert undoes it.
import { can } from "./auth.js";
import { fail, json } from "./http.js";
import { J, now, parse, write } from "./db.js";
import { newBatchId, isConflict } from "./store.js";
import { validateBatch, slugify } from "./research.js";
import { detailsVisible } from "./edit-access.js";
import { followAlias } from "./scope.js";
import { S } from "../strings/index.ts";

const M = S.api.stories;
const linksIn = (body) => [...String(body || "").matchAll(/\[\[([^|\]]+)/g)].map((m) => m[1].trim());
/** Everyone a story names: the people it's about and the people its body links. */
export const storyPeople = (s) => (s ? [...(s.people || []), ...linksIn(s.body)] : []);
export const storyVisible = (b, s) => storyPeople(s).every((id) => detailsVisible(b, followAlias(b.aliases, id)));

export async function route(c, p, m, { body, grantOrFail, scoped }) {
  let r;
  if (p === "/api/stories" && m === "POST") { const d = await body(c); return save(c, null, d, { grantOrFail, scoped }); }
  if ((r = p.match(/^\/api\/stories\/([\w-]+)$/))) {
    if (m === "PUT") { const d = await body(c); return save(c, r[1], d, { grantOrFail, scoped }); }
    if (m === "DELETE") return remove(c, r[1], await c.request.json().catch(() => ({})), { grantOrFail, scoped });
  }
  return null;
}

async function editor(c, d, { grantOrFail, scoped }) {
  const g = grantOrFail(c, (d && d.tree) || c.url.searchParams.get("tree"));
  if (!can.review(g) || c.access.kind === "agent") fail(403, M.editorsOnly);
  return scoped(c, g);
}

const text = (v, max) => String(v ?? "").trim().slice(0, max);

async function save(c, slug, d, deps) {
  const b = await editor(c, d, deps);
  const DB = c.env.DB;
  let row = null, before = null;
  if (slug) {
    row = await DB.prepare("SELECT data, version FROM stories WHERE slug = ?").bind(slug).first();
    before = row && parse(row.data, null);
    if (!before || !storyVisible(b, before)) fail(404, M.noSuch(slug));
    if (d.version != null && +d.version !== row.version) fail(409, M.changed, { version: row.version });
  }
  const after = { ...(before || {}) };
  if (!before || d.title !== undefined) after.title = text(d.title, 300);
  if (!before || d.body !== undefined) after.body = String(d.body ?? "").slice(0, 100000);
  if (!before || d.people !== undefined) after.people = [...new Set((Array.isArray(d.people) ? d.people : []).map(String))];
  if (!before || d.sources !== undefined) after.sources = Array.isArray(d.sources) ? d.sources.filter((x) => x && typeof x === "object").slice(0, 100) : [];
  if (d.era !== undefined) { if (text(d.era, 80)) after.era = text(d.era, 80); else delete after.era; }
  if (!after.body.trim()) fail(400, M.bodyRequired);
  const errs = validateBatch({ stories: [after] }, (id) => detailsVisible(b, followAlias(b.aliases, id)));
  if (errs.length) fail(422, M.invalid, { errors: errs.map((e) => e.replace(/^stories\[0\]/, "story")) });

  const t = now();
  if (before) after.revised = t.slice(0, 10);
  else {
    let base = slugify(d.slug || after.title) || "story", s = base, n = 1;
    while (await DB.prepare("SELECT 1 FROM stories WHERE slug = ?").bind(s).first()) s = `${base.slice(0, 55)}-${++n}`;
    slug = s;
    const branches = new Set(after.people.map((id) => b.people[id] && b.people[id].branch).filter(Boolean));
    if (branches.size === 1) after.branch = [...branches][0];
  }
  after.slug = slug;
  if (before && J(before) === J(after)) return json({ ok: true, story: after, version: row.version, unchanged: true });

  const batch = newBatchId();
  try {
    await write(c.env, [
      // someone else's change since we read it rolls the whole batch back
      ...(before ? [DB.prepare("INSERT INTO _guard (x) SELECT NULL WHERE NOT EXISTS (SELECT 1 FROM stories WHERE slug = ? AND version = ?)").bind(slug, row.version)] : []),
      before
        ? DB.prepare("UPDATE stories SET data = ?, updated_at = ?, updated_by = ?, version = version + 1 WHERE slug = ?").bind(J(after), t, c.access.principal, slug)
        : DB.prepare("INSERT INTO stories (slug, data, updated_at, updated_by) VALUES (?, ?, ?, ?)").bind(slug, J(after), t, c.access.principal),
      logRow(c, { slug, op: before ? "revise" : "create", before, after, reason: d.reason, batch, t }),
    ]);
  } catch (e) { if (isConflict(e) || /UNIQUE/i.test(String(e && e.message))) fail(409, M.changed); throw e; }
  return json({ ok: true, story: after, version: before ? row.version + 1 : 1, batch }, before ? 200 : 201);
}

async function remove(c, slug, d, deps) {
  const b = await editor(c, d, deps);
  const row = await c.env.DB.prepare("SELECT data, version FROM stories WHERE slug = ?").bind(slug).first();
  const before = row && parse(row.data, null);
  if (!before || !storyVisible(b, before)) fail(404, M.noSuch(slug));
  const t = now(), batch = newBatchId();
  await write(c.env, [
    c.env.DB.prepare("DELETE FROM stories WHERE slug = ?").bind(slug),
    logRow(c, { slug, op: "delete", before, after: null, reason: d.reason, batch, t }),
  ]);
  return json({ ok: true, deleted: slug, batch });
}

const logRow = (c, { slug, op, before, after, reason, batch, t }) => c.env.DB.prepare(
  "INSERT INTO changes (at, actor, actor_kind, entity_type, entity_id, op, before, after, reason, batch_id) VALUES (?, ?, 'person', 'story', ?, ?, ?, ?, ?, ?)",
).bind(t, c.access.principal, slug, op, before == null ? null : J(before), after == null ? null : J(after), text(reason, 2000) || null, batch);

/** Statements that undo one story row of a batch, if the story still holds what that batch wrote. */
export async function revertStatements(env, r, { t, actor, actorKind, reason, batch }) {
  const before = parse(r.before), after = parse(r.after);
  const cur = await env.DB.prepare("SELECT data FROM stories WHERE slug = ?").bind(r.entity_id).first();
  if (J(cur ? parse(cur.data, null) : null) !== J(after ?? null)) throw Object.assign(new Error("changed since"), { conflict: true });
  const st = [];
  if (before == null) st.push(env.DB.prepare("DELETE FROM stories WHERE slug = ?").bind(r.entity_id));
  else st.push(env.DB.prepare("INSERT INTO stories (slug, data, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(slug) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by, version = version + 1")
    .bind(r.entity_id, J(before), t, actor));
  st.push(env.DB.prepare("INSERT INTO changes (at, actor, actor_kind, entity_type, entity_id, op, before, after, reason, batch_id) VALUES (?, ?, ?, 'story', ?, 'revert', ?, ?, ?, ?)")
    .bind(t, actor, actorKind, r.entity_id, r.after, r.before, reason, batch));
  return st;
}
