/**
 * Family-tree Worker. The database is the source of truth (docs/design/source-of-truth.md).
 *
 *   GET  /api/me                         who you are, which trees you can see, your role in each
 *   GET  /api/tree?tree=ID               the tree, derived from raw rows and scoped to your grant + view
 *   GET  /api/todos?tree=&status=&assignee=me|unassigned|<principal>&person=
 *   POST /api/todos                      {person?, task, where?, priority?, assignee?}
 *   PATCH /api/todos/:id                 {version, status?, assignee?, priority?, task?, where?, outcome?, comment?}
 *   POST /api/todos/:id/claim            assign to yourself and start (the agent work-queue primitive)
 *   GET  /api/todos/:id/events           history and comments
 *   GET  /api/queue?tree=                your work: assigned to you and not finished, then unassigned open to-dos
 *   GET  /api/proposals?tree=&status=    suggestions queue
 *   POST /api/proposals                  {tree, kind: "research", payload, rationale?, todo_id?}
 *   POST /api/proposals/:id/approve|reject|withdraw
 *   GET  /api/admin, PUT /api/admin/{trees,views,members}/:id, PUT|DELETE /api/admin/grants   (owner only)
 *   GET  /media/<key>                    photos/documents from R2, only if attached to someone you can see
 *   everything else                      static app from ./site (contains no family data)
 *
 * Privacy: every /api and /media request needs a verified Cloudflare Access identity (fails closed), and data is
 * filtered per tree and view in worker/scope.js before it leaves the Worker.
 */
import * as Derive from "./derive.js";
import { identify, resolveAccess, grantFor, can } from "./auth.js";
import { scopeBundle } from "./scope.js";
import { validateBatch, researchStatements } from "./research.js";
import { J, now, parse, dataVersion, loadState, todoOut, write, audit, meta } from "./db.js";
import { runBackup, exportAll } from "./backup.js";

const TODO_STATUSES = ["open", "in_progress", "needs_review", "done", "wont_do"];
const PRIORITY = ["high", "medium", "low"];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith("/api/");
    const isMedia = url.pathname.startsWith("/media/");
    if (!isApi && !isMedia) return env.ASSETS.fetch(request);

    const ident = await identify(request, env);
    if (!ident.ok) return json({ error: ident.error }, 403);
    if (!env.DB) return json({ error: "No D1 binding named DB. See README → Deploy." }, 500);
    try {
      const access = await resolveAccess(env, ident);
      const c = { request, env, ctx, url, access, ident };
      if (isMedia) return await media(c);
      return await route(c);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...(e.extra || {}) }, e.status);
      console.error(e);
      return json({ error: "Internal error" }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBackup(env));
  },
};

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

async function route(c) {
  const { request, url } = c;
  const m = request.method;
  const p = url.pathname.replace(/\/+$/, "");
  let r;
  if (p === "/api/me" && m === "GET") return me(c);
  if (p === "/api/tree" && m === "GET") return json(await scoped(c, grantOrFail(c)), 200, { "Cache-Control": "private, no-store" });
  if (p === "/api/todos" && m === "GET") return listTodos(c);
  if (p === "/api/todos" && m === "POST") return createTodo(c);
  if ((r = p.match(/^\/api\/todos\/(\d+)$/)) && m === "PATCH") return updateTodo(c, +r[1]);
  if ((r = p.match(/^\/api\/todos\/(\d+)\/claim$/)) && m === "POST") return claimTodo(c, +r[1]);
  if ((r = p.match(/^\/api\/todos\/(\d+)\/events$/)) && m === "GET") return todoEvents(c, +r[1]);
  if (p === "/api/queue" && m === "GET") return queue(c);
  if (p === "/api/proposals" && m === "GET") return listProposals(c);
  if (p === "/api/proposals" && m === "POST") return createProposal(c);
  if ((r = p.match(/^\/api\/proposals\/(\d+)\/(approve|reject|withdraw)$/)) && m === "POST") return reviewProposal(c, +r[1], r[2]);
  if (p === "/api/admin" && m === "GET") return admin(c);
  if ((r = p.match(/^\/api\/admin\/(trees|views|members)\/([^/]+)$/)) && m === "PUT") return adminPut(c, r[1], decodeURIComponent(r[2]));
  if (p === "/api/admin/grants" && (m === "PUT" || m === "DELETE")) return adminGrant(c, m);
  if (p === "/api/export.json" && m === "GET") {
    if (!c.access.isOwner) fail(403, "Only the owner can export the whole database.");
    return json(await exportAll(c.env), 200, { "Content-Disposition": `attachment; filename="family-tree-${now().slice(0, 10)}.json"` });
  }
  fail(404, "Not found");
}

// ---------------------------------------------------------------- reading
let derivedCache = { version: -1, full: null };
const scopedCache = new Map();

async function fullBundle(env) {
  const v = await dataVersion(env);
  if (derivedCache.version !== v) {
    const state = await loadState(env);
    if (!state.research.home_person && !Object.keys(state.raw.people).length) fail(404, "The database is empty. Run the one-time import (README → Deploy).");
    const full = Derive.derive({ raw: state.raw, research: state.research, places: state.places }, { today: now().slice(0, 10) });
    full.aliases = state.aliases;
    // to-dos keep their workflow fields (derive passes research through)
    derivedCache = { version: v, full };
    scopedCache.clear();
  }
  return derivedCache;
}

function grantOrFail(c, treeId) {
  const g = grantFor(c.access, treeId || c.url.searchParams.get("tree"));
  if (!g) fail(403, c.access.grants.length ? "You don't have access to that tree." : "No family trees have been shared with you yet. Ask the owner to invite you.");
  return g;
}

async function scoped(c, grant) {
  const { version, full } = await fullBundle(c.env);
  const key = `${version}|${grant.tree_id}|${grant.view_id || ""}|${c.access.personId || ""}|${c.access.isOwner}`;
  if (scopedCache.has(key)) return scopedCache.get(key);
  const t = c.access.treeById[grant.tree_id];
  const tree = { id: t.id, name: t.name, definition: parse(t.definition, { branches: ["*"] }) };
  let view = null;
  if (grant.view_id) {
    const vr = await c.env.DB.prepare("SELECT filter FROM views WHERE id = ?").bind(grant.view_id).first();
    view = vr ? parse(vr.filter, {}) : { living: "hidden", research: false, notes: false, media: false, sources: false }; // missing view fails closed
  }
  const out = scopeBundle(full, {
    tree, view, viewerPersonId: c.access.personId, isOwner: c.access.isOwner,
    helpers: { relationLabels: Derive.relationLabels, checkIssues: Derive.checkIssues },
  });
  out.me = { principal: c.access.principal, role: grant.role, tree: grant.tree_id, isOwner: c.access.isOwner };
  if (scopedCache.size > 50) scopedCache.clear();
  scopedCache.set(key, out);
  return out;
}

async function me(c) {
  const a = c.access;
  return json({
    principal: a.principal, kind: a.kind, displayName: a.displayName, isOwner: a.isOwner, personId: a.personId,
    trees: a.grants.map((g) => ({ id: g.tree_id, name: g.tree_name, role: g.role, view: g.view_id })),
    sourceOfTruth: await meta(c.env, "source_of_truth"),
  });
}

// ---------------------------------------------------------------- to-dos
async function body(c) {
  try { return await c.request.json(); } catch { fail(400, "Body must be JSON."); }
}
const self = (c) => c.access.principal;
const actorKind = (c) => (c.access.kind === "agent" ? "agent" : "person");

async function visibleTodo(c, grant, row) {
  const b = await scoped(c, grant);
  if (!b.scope.view.research) return false;
  return row.person_id ? !!b.people[row.person_id] : (!row.tree_id || row.tree_id === grant.tree_id);
}

async function listTodos(c) {
  const g = grantOrFail(c);
  const sp = c.url.searchParams;
  let rows = (await c.env.DB.prepare("SELECT * FROM todos ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, id").all()).results;
  const b = await scoped(c, g);
  if (!b.scope.view.research) return json({ todos: [] });
  rows = rows.filter((r) => (r.person_id ? !!b.people[r.person_id] : (!r.tree_id || r.tree_id === g.tree_id)));
  const st = sp.get("status");
  if (st === "active") rows = rows.filter((r) => !["done", "wont_do"].includes(r.status));
  else if (st) rows = rows.filter((r) => st.split(",").includes(r.status));
  const as = sp.get("assignee");
  if (as === "me") rows = rows.filter((r) => r.assignee === self(c));
  else if (as === "unassigned") rows = rows.filter((r) => !r.assignee);
  else if (as) rows = rows.filter((r) => r.assignee === as.toLowerCase());
  if (sp.get("person")) rows = rows.filter((r) => r.person_id === sp.get("person"));
  return json({ todos: rows.map(todoOut) });
}

async function createTodo(c) {
  const g = grantOrFail(c, (await peekTree(c)));
  const d = await body(c);
  if (!can.createTodo(g)) fail(403, "You can't add to-dos in this tree.");
  if (!String(d.task || "").trim()) fail(400, "task is required");
  const priority = d.priority || "medium";
  if (!PRIORITY.includes(priority)) fail(400, "priority must be high, medium or low");
  const b = await scoped(c, g);
  if (d.person && !b.people[d.person]) fail(403, "That person isn't in a tree you can see.");
  let assignee = d.assignee ? String(d.assignee).toLowerCase() : null;
  if (assignee === "me") assignee = self(c);
  if (assignee && assignee !== self(c) && !can.editTodos(g)) fail(403, "Only editors can assign to-dos to someone else.");
  const t = now();
  const ins = await c.env.DB.prepare("INSERT INTO todos (person_id, tree_id, task, location, priority, status, assignee, branch, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?) RETURNING *")
    .bind(d.person || null, d.person ? null : g.tree_id, d.task.trim(), d.where || null, priority, assignee, d.person ? b.people[d.person].branch : null, t, self(c), t, self(c)).first();
  await write(c.env, [
    c.env.DB.prepare("INSERT INTO todo_events (todo_id, at, actor, kind, data) VALUES (?, ?, ?, 'created', ?)").bind(ins.id, t, self(c), J({ assignee })),
    audit(c.env, { actor: self(c), actorKind: actorKind(c), entityType: "todo", entityId: ins.id, op: "create", after: todoOut(ins) }),
  ]);
  return json({ todo: todoOut(ins) }, 201);
}

async function peekTree(c) {
  const t = c.url.searchParams.get("tree");
  if (t) return t;
  try { const d = await c.request.clone().json(); return d.tree || null; } catch { return null; }
}

async function loadTodo(c, id) {
  const row = await c.env.DB.prepare("SELECT * FROM todos WHERE id = ?").bind(id).first();
  if (!row) fail(404, "No such to-do.");
  // find a grant under which this to-do is visible
  for (const g of c.access.grants) if (await visibleTodo(c, g, row)) return { row, g };
  fail(404, "No such to-do.");
}

async function updateTodo(c, id) {
  const { row, g } = await loadTodo(c, id);
  const d = await body(c);
  if (d.version != null && d.version !== row.version) fail(409, "Someone changed this to-do. Reload and try again.", { todo: todoOut(row) });
  const editor = can.editTodos(g);
  const mine = row.assignee === self(c);
  const isAgent = c.access.kind === "agent";
  const changes = {}, events = [];
  if (d.status && d.status !== row.status) {
    if (!TODO_STATUSES.includes(d.status)) fail(400, `status must be one of ${TODO_STATUSES.join(", ")}`);
    const selfAllowed = ["open", "in_progress", "needs_review"].includes(d.status);
    if (!(editor && !isAgent) && !(mine && selfAllowed)) fail(403, isAgent ? "Agents finish work by moving it to needs_review; an editor closes it." : "Only the assignee or an editor can change the status.");
    changes.status = d.status;
    changes.closed_at = ["done", "wont_do"].includes(d.status) ? now() : null;
    events.push(["status", { from: row.status, to: d.status }]);
  }
  if ("assignee" in d) {
    let a = d.assignee ? String(d.assignee).toLowerCase() : null;
    if (a === "me") a = self(c);
    const selfOnly = a === self(c) && (!row.assignee || mine) || (a === null && mine);
    if (!editor && !selfOnly) fail(403, "Only editors can assign to-dos to someone else.");
    if (a !== row.assignee) { changes.assignee = a; events.push(["assigned", { from: row.assignee, to: a }]); }
  }
  for (const [k, col] of [["priority", "priority"], ["task", "task"], ["where", "location"]]) {
    if (k in d && d[k] !== row[col]) {
      if (!editor) fail(403, "Only editors can edit a to-do's details.");
      if (k === "priority" && !PRIORITY.includes(d[k])) fail(400, "priority must be high, medium or low");
      changes[col] = d[k];
      events.push(["edited", { field: k, from: row[col], to: d[k] }]);
    }
  }
  if ("outcome" in d && d.outcome !== row.outcome) {
    if (!editor && !mine) fail(403, "Only the assignee or an editor can record an outcome.");
    changes.outcome = d.outcome;
    events.push(["edited", { field: "outcome", to: d.outcome }]);
  }
  if (d.comment) events.push(["comment", { text: String(d.comment).slice(0, 4000) }]);
  if (!Object.keys(changes).length && !events.length) return json({ todo: todoOut(row) });
  const t = now();
  const st = [];
  if (Object.keys(changes).length) {
    const cols = Object.keys(changes);
    st.push(c.env.DB.prepare(`UPDATE todos SET ${cols.map((k) => `${k} = ?`).join(", ")}, updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ? AND version = ?`)
      .bind(...cols.map((k) => changes[k]), t, self(c), id, row.version));
    st.push(audit(c.env, { actor: self(c), actorKind: actorKind(c), entityType: "todo", entityId: id, op: "update", before: todoOut(row), after: changes }));
  }
  for (const [kind, data] of events) st.push(c.env.DB.prepare("INSERT INTO todo_events (todo_id, at, actor, kind, data) VALUES (?, ?, ?, ?, ?)").bind(id, t, self(c), kind, J(data)));
  const res = await write(c.env, st);
  if (Object.keys(changes).length && res[0].meta && res[0].meta.changes === 0) fail(409, "Someone changed this to-do. Reload and try again.");
  const fresh = await c.env.DB.prepare("SELECT * FROM todos WHERE id = ?").bind(id).first();
  return json({ todo: todoOut(fresh) });
}

async function claimTodo(c, id) {
  const { row } = await loadTodo(c, id);
  if (row.assignee && row.assignee !== self(c)) fail(409, `Already assigned to ${row.assignee}.`);
  if (["done", "wont_do"].includes(row.status)) fail(409, "This to-do is closed.");
  const t = now();
  const res = await write(c.env, [
    c.env.DB.prepare("UPDATE todos SET assignee = ?, status = 'in_progress', updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ? AND version = ? AND (assignee IS NULL OR assignee = ?)")
      .bind(self(c), t, self(c), id, row.version, self(c)),
    c.env.DB.prepare("INSERT INTO todo_events (todo_id, at, actor, kind, data) VALUES (?, ?, ?, 'assigned', ?)").bind(id, t, self(c), J({ from: row.assignee, to: self(c), claimed: true })),
  ]);
  if (res[0].meta && res[0].meta.changes === 0) fail(409, "Someone else claimed it first.");
  return json({ todo: todoOut(await c.env.DB.prepare("SELECT * FROM todos WHERE id = ?").bind(id).first()) });
}

async function todoEvents(c, id) {
  await loadTodo(c, id);
  const rows = (await c.env.DB.prepare("SELECT * FROM todo_events WHERE todo_id = ? ORDER BY id").bind(id).all()).results;
  return json({ events: rows.map((r) => ({ id: r.id, at: r.at, actor: r.actor, kind: r.kind, data: parse(r.data, {}) })) });
}

async function queue(c) {
  const g = grantOrFail(c);
  const b = await scoped(c, g);
  if (!b.scope.view.research) return json({ assigned: [], available: [] });
  const rows = (await c.env.DB.prepare("SELECT * FROM todos WHERE status IN ('open','in_progress','needs_review') ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, id").all()).results
    .filter((r) => (r.person_id ? !!b.people[r.person_id] : (!r.tree_id || r.tree_id === g.tree_id)));
  return json({
    assigned: rows.filter((r) => r.assignee === self(c) && r.status !== "needs_review").map(todoOut),
    available: rows.filter((r) => !r.assignee && r.status === "open").map(todoOut),
  });
}

// ---------------------------------------------------------------- suggestions queue
function proposalOut(r) {
  return { id: r.id, created_at: r.created_at, author: r.author, author_kind: r.author_kind, tree: r.tree_id, kind: r.kind,
    payload: parse(r.payload, {}), rationale: r.rationale, todo_id: r.todo_id, status: r.status,
    reviewed_by: r.reviewed_by, reviewed_at: r.reviewed_at, review_note: r.review_note };
}

async function listProposals(c) {
  const g = grantOrFail(c);
  const st = c.url.searchParams.get("status") || "open";
  let rows = (await c.env.DB.prepare("SELECT * FROM proposals WHERE tree_id = ? AND (? = 'all' OR status = ?) ORDER BY id DESC LIMIT 200").bind(g.tree_id, st, st).all()).results;
  if (!can.review(g)) rows = rows.filter((r) => r.author === self(c)); // members see their own suggestions
  return json({ proposals: rows.map(proposalOut) });
}

async function createProposal(c) {
  const d = await body(c);
  const g = grantOrFail(c, d.tree);
  if (!can.propose(g)) fail(403, "You can't make suggestions in this tree.");
  const kind = d.kind || "research";
  if (kind === "edit") fail(501, "Tree-edit suggestions arrive with the editing phase (issue #5). Submit research batches for now.");
  if (kind !== "research") fail(400, "kind must be research");
  const b = await scoped(c, g);
  const errs = validateBatch(d.payload, (pid) => !!b.people[pid]);
  if (errs.length) fail(422, "The batch didn't validate.", { errors: errs });
  let todo = null;
  if (d.todo_id) {
    todo = (await loadTodo(c, d.todo_id)).row;
  }
  const t = now();
  const ins = await c.env.DB.prepare("INSERT INTO proposals (created_at, author, author_kind, tree_id, kind, payload, rationale, todo_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *")
    .bind(t, self(c), actorKind(c), g.tree_id, kind, J(d.payload), d.rationale || null, todo ? todo.id : null).first();
  const st = [audit(c.env, { actor: self(c), actorKind: actorKind(c), entityType: "proposal", entityId: ins.id, op: "create", after: { kind, todo_id: ins.todo_id } })];
  if (todo) {
    st.push(c.env.DB.prepare("INSERT INTO todo_events (todo_id, at, actor, kind, data) VALUES (?, ?, ?, 'proposal', ?)").bind(todo.id, t, self(c), J({ proposal: ins.id })));
    if (todo.assignee === self(c) && !["done", "wont_do", "needs_review"].includes(todo.status)) {
      st.push(c.env.DB.prepare("UPDATE todos SET status = 'needs_review', updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?").bind(t, self(c), todo.id));
      st.push(c.env.DB.prepare("INSERT INTO todo_events (todo_id, at, actor, kind, data) VALUES (?, ?, ?, 'status', ?)").bind(todo.id, t, self(c), J({ from: todo.status, to: "needs_review", proposal: ins.id })));
    }
  }
  await write(c.env, st);
  return json({ proposal: proposalOut(ins) }, 201);
}

async function reviewProposal(c, id, action) {
  const row = await c.env.DB.prepare("SELECT * FROM proposals WHERE id = ?").bind(id).first();
  if (!row) fail(404, "No such suggestion.");
  const g = grantFor(c.access, row.tree_id);
  if (!g) fail(404, "No such suggestion.");
  if (row.status !== "open") fail(409, `This suggestion is already ${row.status}.`);
  const d = await c.request.json().catch(() => ({}));
  const t = now();
  if (action === "withdraw") {
    if (row.author !== self(c)) fail(403, "Only the author can withdraw a suggestion.");
    await write(c.env, [c.env.DB.prepare("UPDATE proposals SET status = 'withdrawn', reviewed_by = ?, reviewed_at = ? WHERE id = ?").bind(self(c), t, id)]);
    return json({ ok: true });
  }
  if (!can.review(g) || c.access.kind === "agent") fail(403, "Only editors can review suggestions.");
  const st = [];
  if (action === "approve") {
    if (row.kind !== "research") fail(501, "Only research suggestions can be approved for now.");
    const payload = parse(row.payload, {});
    const b = await scoped(c, g);
    const errs = validateBatch(payload, (pid) => !!b.people[pid]); // re-check: the tree may have changed
    if (errs.length) fail(422, "The batch no longer validates.", { errors: errs });
    st.push(...await researchStatements(c.env, payload, { actor: self(c), actorKind: "person", proposalId: id, treeId: row.tree_id }));
    if (row.todo_id) {
      const td = await c.env.DB.prepare("SELECT * FROM todos WHERE id = ?").bind(row.todo_id).first();
      const closedByBatch = (payload.todo_done || []).some((x) => x.id === row.todo_id);
      if (td && td.status === "needs_review" && !closedByBatch && d.close_todo !== false) {
        st.push(c.env.DB.prepare("UPDATE todos SET status = 'done', closed_at = ?, outcome = COALESCE(NULLIF(outcome, ''), ?), updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?").bind(t, `See suggestion #${id}.`, t, self(c), td.id));
        st.push(c.env.DB.prepare("INSERT INTO todo_events (todo_id, at, actor, kind, data) VALUES (?, ?, ?, 'status', ?)").bind(td.id, t, self(c), J({ from: "needs_review", to: "done", proposal: id })));
      }
    }
  } else if (row.todo_id) {
    const td = await c.env.DB.prepare("SELECT * FROM todos WHERE id = ?").bind(row.todo_id).first();
    if (td && td.status === "needs_review") {
      st.push(c.env.DB.prepare("UPDATE todos SET status = 'in_progress', updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?").bind(t, self(c), td.id));
      st.push(c.env.DB.prepare("INSERT INTO todo_events (todo_id, at, actor, kind, data) VALUES (?, ?, ?, 'status', ?)").bind(td.id, t, self(c), J({ from: "needs_review", to: "in_progress", proposal: id, rejected: true, note: d.note || "" })));
    }
  }
  st.push(c.env.DB.prepare("UPDATE proposals SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ? AND status = 'open'")
    .bind(action === "approve" ? "approved" : "rejected", self(c), t, d.note || null, id));
  st.push(audit(c.env, { actor: self(c), actorKind: "person", entityType: "proposal", entityId: id, op: action, reason: d.note || null, proposalId: id }));
  await write(c.env, st);
  return json({ ok: true, status: action === "approve" ? "approved" : "rejected" });
}

// ---------------------------------------------------------------- admin (owner only)
async function admin(c) {
  if (!can.admin(c.access)) fail(403, "Owner only.");
  const q = (s) => c.env.DB.prepare(s).all().then((r) => r.results);
  const [trees, views, members, grants] = await Promise.all([q("SELECT * FROM trees"), q("SELECT * FROM views"), q("SELECT * FROM members"), q("SELECT * FROM grants")]);
  return json({
    trees: trees.map((t) => ({ ...t, definition: parse(t.definition, {}) })),
    views: views.map((v) => ({ ...v, filter: parse(v.filter, {}) })), members, grants,
  });
}

async function adminPut(c, kind, id) {
  if (!can.admin(c.access)) fail(403, "Owner only.");
  const d = await body(c);
  const t = now();
  let stmt;
  if (kind === "trees") {
    if (!d.name || !d.definition) fail(400, "name and definition are required");
    stmt = c.env.DB.prepare("INSERT INTO trees (id, name, definition, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, definition = excluded.definition, updated_at = excluded.updated_at").bind(id, d.name, J(d.definition), t, t);
  } else if (kind === "views") {
    if (!d.name || !d.filter) fail(400, "name and filter are required");
    if (d.filter.living && !["full", "names-only", "anonymous", "hidden"].includes(d.filter.living)) fail(400, "filter.living must be full, names-only, anonymous or hidden");
    stmt = c.env.DB.prepare("INSERT INTO views (id, name, filter, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, filter = excluded.filter, updated_at = excluded.updated_at").bind(id, d.name, J(d.filter), t, t);
  } else {
    const principal = id.toLowerCase();
    stmt = c.env.DB.prepare("INSERT INTO members (principal, kind, display_name, person_id, is_owner, created_at, invited_by) VALUES (?, ?, ?, ?, 0, ?, ?) ON CONFLICT(principal) DO UPDATE SET kind = excluded.kind, display_name = excluded.display_name, person_id = excluded.person_id")
      .bind(principal, d.kind === "agent" ? "agent" : "person", d.display_name || null, d.person_id || null, t, self(c));
  }
  await write(c.env, [stmt, audit(c.env, { actor: self(c), actorKind: "person", entityType: kind.slice(0, -1), entityId: id, op: "put", after: d })]);
  return json({ ok: true });
}

async function adminGrant(c, method) {
  if (!can.admin(c.access)) fail(403, "Owner only.");
  const d = method === "PUT" ? await body(c) : Object.fromEntries(c.url.searchParams);
  if (!d.principal || !d.tree_id) fail(400, "principal and tree_id are required");
  const principal = d.principal.toLowerCase();
  let stmt;
  if (method === "PUT") {
    if (!["editor", "member", "agent"].includes(d.role)) fail(400, "role must be editor, member or agent");
    stmt = c.env.DB.prepare("INSERT INTO grants (principal, tree_id, role, view_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(principal, tree_id) DO UPDATE SET role = excluded.role, view_id = excluded.view_id")
      .bind(principal, d.tree_id, d.role, d.view_id || null, self(c), now());
  } else {
    stmt = c.env.DB.prepare("DELETE FROM grants WHERE principal = ? AND tree_id = ?").bind(principal, d.tree_id);
  }
  await write(c.env, [stmt, audit(c.env, { actor: self(c), actorKind: "person", entityType: "grant", entityId: `${principal}|${d.tree_id}`, op: method === "PUT" ? "put" : "delete", after: d })]);
  return json({ ok: true });
}

// ---------------------------------------------------------------- media
async function media(c) {
  if (!c.env.MEDIA) return json({ error: "No R2 binding named MEDIA." }, 404);
  const key = decodeURIComponent(c.url.pathname.slice("/media/".length));
  if (!key || key.includes("..")) return json({ error: "Bad key" }, 400);
  let allowed = false;
  for (const g of c.access.grants) {
    const b = await scoped(c, g);
    const files = new Set([
      ...Object.values(b.research.media || {}).flat().map((m) => m.file),
      ...Object.values(b.media || {}).map((m) => m.file),
    ]);
    if (files.has(key)) { allowed = true; break; }
  }
  if (!allowed) return json({ error: "Not found" }, 404);
  const obj = await c.env.MEDIA.get(key);
  if (!obj) return json({ error: "Not found" }, 404);
  const headers = new Headers({ "Cache-Control": "private, max-age=86400" });
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  return new Response(obj.body, { headers });
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: Object.assign({ "Content-Type": "application/json; charset=utf-8", "X-Robots-Tag": "noindex" }, extra) });
}
