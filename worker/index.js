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
 *   /api/agent/runs, /api/profiles/:id/refresh, /api/content/refresh   cloud research agents (worker/agent/routes.js)
 *   GET  /api/admin, PUT /api/admin/{trees,views,members}/:id, PUT|DELETE /api/admin/grants   (owner only)
 *   GET  /media/<key>                    photos/documents from R2, only if attached to someone you can see
 *   everything else                      static app from ./site (contains no family data)
 *
 * Privacy: every /api and /media request needs a verified Cloudflare Access identity (fails closed), and data is
 * filtered per tree and view in worker/scope.js before it leaves the Worker.
 */
import { identify, resolveAccess, grantFor, can } from "./auth.js";
import { HttpError, fail, json } from "./http.js";
import { scopeFor } from "./bundle.js";
import * as Agent from "./agent/routes.js";
import { validateBatch, researchStatements } from "./research.js";
import { J, now, parse, loadState, todoOut, write, audit, meta } from "./db.js";
import { OpError, referencedIds, applyOps, assignFids } from "./ops.js";
import { loadEditable, applyAndCommit, revertBatch, isConflict, newBatchId } from "./store.js";
import * as Graph from "./graph.js";
import * as Prov from "./prov.js";
import * as GedcomX from "./gedcomx.js";
import * as Storage from "./storage.js";
import { exportGedcom } from "./gedcom_export.js";

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
};

async function route(c) {
  const { request, url } = c;
  const m = request.method;
  const p = url.pathname.replace(/\/+$/, "");
  let r;
  if (p === "/api/me" && m === "GET") return me(c);
  if (p === "/api/tree" && m === "GET") {
    const g = grantOrFail(c), pv = c.url.searchParams.get("preview_view");
    if (pv && !c.access.isOwner) fail(403, "Only the owner can preview views.");
    return json(await scoped(c, pv ? { ...g, view_id: pv, role: "member" } : g), 200, { "Cache-Control": "private, no-store" });
  }
  if (p === "/api/todos" && m === "GET") return listTodos(c);
  if (p === "/api/todos" && m === "POST") return createTodo(c);
  if ((r = p.match(/^\/api\/todos\/(\d+)$/)) && m === "PATCH") return updateTodo(c, +r[1]);
  if ((r = p.match(/^\/api\/todos\/(\d+)\/claim$/)) && m === "POST") return claimTodo(c, +r[1]);
  if ((r = p.match(/^\/api\/todos\/(\d+)\/events$/)) && m === "GET") return todoEvents(c, +r[1]);
  if (p === "/api/queue" && m === "GET") return queue(c);
  if (p === "/api/proposals" && m === "GET") return listProposals(c);
  if (p === "/api/proposals" && m === "POST") return createProposal(c);
  if ((r = p.match(/^\/api\/proposals\/(\d+)\/(approve|reject|withdraw)$/)) && m === "POST") return reviewProposal(c, +r[1], r[2]);
  if (p === "/api/export.ged" && m === "GET") return exportGed(c);
  if (p === "/api/export.json" && m === "GET") return exportJson(c);
  if (p === "/api/export.gedcomx" && m === "GET") return exportGedcomx(c);
  if (p === "/api/admin/storage" && m === "POST") return adminStorage(c);
  if (p === "/api/admin/import.gedcomx" && m === "POST") return adminImportGx(c);
  if (p === "/api/edit" && m === "POST") return edit(c);
  if (p === "/api/edit/preview" && m === "POST") return previewEdit(c);
  if ((r = p.match(/^\/api\/findings\/(\d+)$/)) && m === "PATCH") return updateFinding(c, +r[1]);
  if (p === "/api/history" && m === "GET") return history(c);
  if (p === "/api/prov" && m === "GET") return provenance(c);
  if ((r = p.match(/^\/api\/changes\/([\w-]+)\/revert$/)) && m === "POST") return revert(c, r[1]);
  if (p === "/api/comments" && m === "GET") return listComments(c);
  if (p === "/api/comments" && m === "POST") return addComment(c);
  if ((r = p.match(/^\/api\/comments\/(\d+)\/resolve$/)) && m === "POST") return resolveComment(c, +r[1]);
  if (p === "/api/media/upload" && m === "POST") return upload(c);
  if ((r = p.match(/^\/api\/graph\/(path|ancestors|descendants)$/)) && m === "GET") return graph(c, r[1]);
  if (p === "/api/me/person" && m === "PUT") return linkMe(c);
  if (p === "/api/agent/runs" && m === "POST") return Agent.startRun(c, await body(c), { grantOrFail, scoped, loadTodo });
  if (p === "/api/agent/runs" && m === "GET") return Agent.listRuns(c, { grantOrFail });
  if ((r = p.match(/^\/api\/agent\/runs\/([\w-]+)$/)) && m === "GET") return Agent.getRun(c, r[1]);
  if ((r = p.match(/^\/api\/agent\/runs\/([\w-]+)\/cancel$/)) && m === "POST") return Agent.cancel(c, r[1]);
  if ((r = p.match(/^\/api\/profiles\/([^/]+)\/refresh$/)) && m === "POST") return Agent.refreshProfileRoute(c, decodeURIComponent(r[1]), { grantOrFail, scoped });
  if (p === "/api/content/refresh" && m === "POST") return Agent.refreshContent(c);
  if (p === "/api/admin" && m === "GET") return admin(c);
  if ((r = p.match(/^\/api\/admin\/(trees|views|members)\/([^/]+)$/)) && m === "PUT") return adminPut(c, r[1], decodeURIComponent(r[2]));
  if (p === "/api/admin/grants" && (m === "PUT" || m === "DELETE")) return adminGrant(c, m);
  fail(404, "Not found");
}

// ---------------------------------------------------------------- reading
function grantOrFail(c, treeId) {
  const g = grantFor(c.access, treeId || c.url.searchParams.get("tree"));
  if (!g) fail(403, c.access.grants.length ? "You don't have access to that tree." : "No family trees have been shared with you yet. Ask the owner to invite you.");
  return g;
}

const scoped = (c, grant) => scopeFor(c.env, c.access, grant);

async function me(c) {
  const a = c.access;
  return json({
    principal: a.principal, kind: a.kind, displayName: a.displayName, isOwner: a.isOwner, personId: a.personId,
    trees: a.grants.map((g) => ({ id: g.tree_id, name: g.tree_name, role: g.role, view: g.view_id })),
    sourceOfTruth: await meta(c.env, "source_of_truth"),
    ai: Agent.enabled(c.env), // research runs and AI profiles are available
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
  if (!["research", "edit"].includes(kind)) fail(400, "kind must be research or edit");
  const b = await scoped(c, g);
  if (kind === "research") {
    const errs = validateBatch(d.payload, (pid) => !!b.people[pid]);
    if (errs.length) fail(422, "The batch didn't validate.", { errors: errs });
  } else {
    await checkEdit(c, g, d.payload, { dryRun: true });
  }
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
    const payload = parse(row.payload, {});
    const b = await scoped(c, g);
    if (row.kind === "edit") {
      await checkEdit(c, g, payload, { dryRun: true });
      // the tree edit is applied together with closing the proposal (and its to-do) in one batch
      const extra = [];
      extra.push(c.env.DB.prepare("UPDATE proposals SET status = 'approved', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ? AND status = 'open'").bind(self(c), t, d.note || null, id));
      extra.push(...await todoCloseStatements(c, row, payload, d, t, id));
      const batchId = newBatchId();
      extra.push(...await resolveStatements(c, g, payload.resolves, { batch: batchId, note: payload.reason || row.rationale, proposal: id }));
      try {
        const res = await applyAndCommit(c.env, payload.ops, { actor: self(c), actorKind: "person", reason: payload.reason || row.rationale || `suggestion #${id} by ${row.author}`, sources: payload.sources, proposalId: id, op: "edit", extra, batchId });
        return json({ ok: true, status: "approved", batch: res.batchId, created: res.created });
      } catch (e) {
        if (e instanceof OpError) fail(422, `This suggestion no longer applies: ${e.message}`);
        if (isConflict(e)) fail(409, "The tree changed while approving. Try again.");
        throw e;
      }
    }
    const errs = validateBatch(payload, (pid) => !!b.people[pid]); // re-check: the tree may have changed
    if (errs.length) fail(422, "The batch no longer validates.", { errors: errs });
    st.push(...await researchStatements(c.env, payload, { actor: self(c), actorKind: "person", proposalId: id, treeId: row.tree_id }));
    st.push(...await todoCloseStatements(c, row, payload, d, t, id));
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

async function todoCloseStatements(c, row, payload, d, t, id) {
  if (!row.todo_id) return [];
  const td = await c.env.DB.prepare("SELECT * FROM todos WHERE id = ?").bind(row.todo_id).first();
  const closedByBatch = (payload.todo_done || []).some((x) => x.id === row.todo_id);
  if (!td || td.status !== "needs_review" || closedByBatch || d.close_todo === false) return [];
  return [
    c.env.DB.prepare("UPDATE todos SET status = 'done', closed_at = ?, outcome = COALESCE(NULLIF(outcome, ''), ?), updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?").bind(t, `See suggestion #${id}.`, t, self(c), td.id),
    c.env.DB.prepare("INSERT INTO todo_events (todo_id, at, actor, kind, data) VALUES (?, ?, ?, 'status', ?)").bind(td.id, t, self(c), J({ from: "needs_review", to: "done", proposal: id })),
  ];
}

// ---------------------------------------------------------------- editing (#5)
/** Validate an edit payload against the caller's scope; with dryRun, also apply it in memory. */
async function checkEdit(c, g, payload, { dryRun }) {
  if (!payload || !Array.isArray(payload.ops) || !payload.ops.length) fail(400, "payload.ops must be a non-empty list");
  const b = await scoped(c, g);
  const { people, families } = referencedIds(payload.ops);
  for (const pid of people) {
    const p = b.people[pid];
    if (!p) fail(403, `Person ${pid} isn't in a tree you can see.`);
    if (p.private) fail(403, `${pid} is shown to you as a name only; you can't change their details.`);
  }
  for (const fid of families) if (!b.families[fid]) fail(403, `Family ${fid} isn't in a tree you can see.`);
  if (dryRun) {
    const { state } = await loadEditable(c.env);
    try { applyOps(state, payload.ops, { actor: self(c) }); }
    catch (e) { if (e instanceof OpError) fail(422, e.message); throw e; }
  }
}

async function edit(c) {
  const d = await body(c);
  const g = grantOrFail(c, d.tree);
  if (c.access.kind === "agent") fail(403, "Agents suggest changes (POST /api/proposals with kind \"edit\"); they don't edit directly.");
  if (!can.review(g)) fail(403, "Only editors can change the tree directly. Use \"Suggest a change\" instead.");
  if (!String(d.reason || "").trim()) fail(400, "Say why (reason) — it's kept in the history.");
  await checkEdit(c, g, d, { dryRun: false });
  const batchId = newBatchId();
  const extra = await resolveStatements(c, g, d.resolves, { batch: batchId, note: d.reason });
  try {
    const res = await applyAndCommit(c.env, d.ops, { actor: self(c), actorKind: "person", reason: d.reason, sources: d.sources, batchId, extra });
    return json({ ok: true, batch: res.batchId, touched: res.touched, created: res.created, resolved: (d.resolves || []).map(Number) });
  } catch (e) {
    if (e instanceof OpError) fail(422, e.message);
    if (isConflict(e)) fail(409, "Someone changed this while you were editing. Reload and try again.");
    throw e;
  }
}

/** What an edit would change, without saving it: before/after snapshots of each record it touches (for diffs). */
async function previewEdit(c) {
  const d = await body(c);
  const g = grantOrFail(c, d.tree);
  if (!can.propose(g)) fail(403, "You can't change or suggest changes in this tree.");
  await checkEdit(c, g, d, { dryRun: false });
  const { state } = await loadEditable(c.env);
  try {
    const res = applyOps(state, d.ops, { actor: self(c) });
    return json({ touched: res.touched.filter((x) => ["person", "family", "media_map", "source"].includes(x.type)) });
  } catch (e) { if (e instanceof OpError) fail(422, e.message); throw e; }
}

// ---------------------------------------------------------------- findings: resolve, dismiss, reopen
const FINDING_STATES = ["open", "resolved", "dismissed"];

async function findingFor(c, g, id) {
  const b = await scoped(c, g);
  if (!b.scope.view.research || !(b.research.findings || []).some((f) => f.id === id)) fail(404, "No such finding.");
  const row = await c.env.DB.prepare("SELECT * FROM findings WHERE id = ?").bind(id).first();
  if (!row) fail(404, "No such finding.");
  return row;
}

/** Statements that mark findings resolved by an edit (same batch, so undoing the edit is one step away). */
async function resolveStatements(c, g, ids, { batch, note, proposal }) {
  const st = [], t = now();
  for (const id of [...new Set((ids || []).map(Number))].slice(0, 50)) {
    const row = await findingFor(c, g, id);
    const data = parse(row.data, {});
    const resolution = { status: "resolved", by: self(c), at: t, note: String(note || "").slice(0, 2000), batch, ...(proposal ? { proposal } : {}) };
    st.push(c.env.DB.prepare("UPDATE findings SET data = ?, version = version + 1 WHERE id = ?").bind(J({ ...data, resolution }), id));
    // logged in the edit's batch, so undoing the edit also reopens the finding
    st.push(c.env.DB.prepare("INSERT INTO changes (at, actor, actor_kind, entity_type, entity_id, op, before, after, reason, proposal_id, batch_id) VALUES (?, ?, ?, 'finding', ?, 'resolve', ?, ?, ?, ?, ?)")
      .bind(t, self(c), actorKind(c), String(id), J(data.resolution || null), J(resolution), note || null, proposal || null, batch));
  }
  return st;
}

async function updateFinding(c, id) {
  const d = await body(c);
  const g = grantOrFail(c, d.tree);
  if (!can.review(g) || c.access.kind === "agent") fail(403, "Only editors can resolve findings.");
  const row = await findingFor(c, g, id);
  if (d.version != null && d.version !== row.version) fail(409, "Someone changed this finding. Reload and try again.");
  if (!FINDING_STATES.includes(d.status)) fail(400, `status must be one of ${FINDING_STATES.join(", ")}`);
  const note = String(d.note || "").trim();
  if (d.status === "dismissed" && !note) fail(400, "Say why the tree stays as it is; the reason is kept with the finding.");
  const data = parse(row.data, {});
  const resolution = d.status === "open" ? undefined : { status: d.status, by: self(c), at: now(), note: note.slice(0, 2000), ...(d.batch ? { batch: String(d.batch) } : {}) };
  const after = { ...data };
  if (resolution) after.resolution = resolution; else delete after.resolution;
  await write(c.env, [
    c.env.DB.prepare("UPDATE findings SET data = ?, version = version + 1 WHERE id = ? AND version = ?").bind(J(after), id, row.version),
    audit(c.env, { actor: self(c), actorKind: "person", entityType: "finding", entityId: id, op: d.status === "open" ? "reopen" : d.status, before: data.resolution || null, after: resolution || null, reason: note || null }),
  ]);
  return json({ ok: true, finding: { id, ...after } });
}

/** The change rows about one person (and their families, findings, photos and status), scoped to the caller. */
async function entityRows(c, g, b, id, { limit = 200 } = {}) {
  if (!b.people[id] && !b.families[id]) fail(404, "Not found.");
  const fams = b.people[id] ? [...(b.people[id].famc || []), ...(b.people[id].fams || [])] : [];
  const ids = [id, ...fams];
  const fids = (b.research.findings || []).filter((f) => f.person === id).map((f) => String(f.id));
  const rows = (await c.env.DB.prepare(`SELECT * FROM changes WHERE (entity_id IN (${ids.map(() => "?").join(",")}) AND entity_type IN ('person','family','status'))${fids.length ? ` OR (entity_type = 'finding' AND entity_id IN (${fids.map(() => "?").join(",")}))` : ""} ORDER BY id DESC LIMIT ${limit}`).bind(...ids, ...fids).all()).results;
  // photo changes live in one config record keyed by person: keep this person's slice
  if (b.people[id]) {
    const media = (await c.env.DB.prepare(`SELECT * FROM changes WHERE entity_type = 'config' AND entity_id = 'media_map' ORDER BY id DESC LIMIT ${limit}`).all()).results;
    for (const r of media) {
      const bf = parse(r.before, {}) || {}, af = parse(r.after, {}) || {};
      if (!(id in bf) && !(id in af)) continue;
      rows.push({ ...r, entity_type: "media", entity_id: id, before: J(bf[id] ?? null), after: J(af[id] ?? null) });
    }
    rows.sort((x, y) => y.id - x.id);
  }
  return rows.filter(visibleRow(c, g, b));
}

/** Never show snapshots of entities outside the caller's scope. */
const visibleRow = (c, g, b) => (r) => ["person", "media", "status"].includes(r.entity_type) ? !!b.people[r.entity_id] || c.access.isOwner
  : r.entity_type === "family" ? !!b.families[r.entity_id] || c.access.isOwner
  : r.entity_type === "finding" ? (b.research.findings || []).some((f) => String(f.id) === r.entity_id)
  : c.access.isOwner || can.review(g);

async function history(c) {
  const g = grantOrFail(c);
  const b = await scoped(c, g);
  const id = c.url.searchParams.get("id");
  let rows;
  if (id) rows = await entityRows(c, g, b, id);
  else {
    if (!can.review(g)) fail(403, "Only editors can see the full history.");
    rows = (await c.env.DB.prepare("SELECT * FROM changes WHERE entity_type IN ('person','family','source','config') ORDER BY id DESC LIMIT 200").all()).results.filter(visibleRow(c, g, b));
  }
  const batches = {};
  for (const r of rows) {
    const k = r.batch_id || `c${r.id}`;
    const g0 = (batches[k] = batches[k] || { batch: r.batch_id, at: r.at, actor: r.actor, op: r.op, reason: r.reason, proposal: r.proposal_id, sources: parse(r.sources, undefined), entities: [] });
    if (r.op === "edit" || r.op === "revert") g0.op = r.op; // an edit that also resolved a finding is still an edit
    g0.entities.push({ type: r.entity_type, id: r.entity_id, change: r.before == null ? "created" : r.after == null ? "deleted" : "updated", before: c.access.isOwner || can.review(g) ? parse(r.before) : undefined, after: c.access.isOwner || can.review(g) ? parse(r.after) : undefined });
  }
  return json({ history: Object.values(batches) });
}

/** PROV-O (JSON-LD) for one person's records, or for one research run. docs/design/standards.md */
async function provenance(c) {
  const g = grantOrFail(c);
  const b = await scoped(c, g);
  const sp = c.url.searchParams;
  let rows = [], runs = [];
  if (sp.get("run")) {
    if (!can.review(g)) fail(403, "Only editors can see research runs.");
    const run = await c.env.DB.prepare("SELECT * FROM agent_runs WHERE id = ? AND tree_id = ?").bind(sp.get("run"), g.tree_id).first();
    if (!run) fail(404, "No such run.");
    runs = [run];
  } else {
    const id = sp.get("id");
    rows = (await entityRows(c, g, b, id, { limit: 1000 })).reverse();
    const pids = [...new Set(rows.map((r) => r.proposal_id).filter(Boolean))];
    if (pids.length) runs = (await c.env.DB.prepare(`SELECT * FROM agent_runs WHERE tree_id = ? AND proposal_ids IS NOT NULL`).bind(g.tree_id).all()).results
      .filter((r) => (parse(r.proposal_ids, []) || []).some((p) => pids.includes(p)));
  }
  const pids = [...new Set([...rows.map((r) => r.proposal_id), ...runs.flatMap((r) => parse(r.proposal_ids, []) || [])].filter(Boolean))];
  const proposals = pids.length ? (await c.env.DB.prepare(`SELECT id, author, author_kind, created_at, reviewed_by, reviewed_at, status, kind FROM proposals WHERE id IN (${pids.map(() => "?").join(",")})`).bind(...pids).all()).results : [];
  const doc = Prov.toProv({ rows, runs, proposals, people: b.people, base: c.url.origin, detail: c.access.isOwner || can.review(g) });
  return new Response(JSON.stringify(doc), { headers: { "Content-Type": "application/ld+json; charset=utf-8", "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" } });
}

async function revert(c, batchId) {
  const g = grantOrFail(c);
  if (!can.review(g) || c.access.kind === "agent") fail(403, "Only editors can revert changes.");
  const d = await c.request.json().catch(() => ({}));
  try {
    const r = await revertBatch(c.env, batchId, { actor: self(c), actorKind: "person", reason: d.reason });
    if (!r) fail(404, "No such change.");
    return json({ ok: true, ...r });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (isConflict(e) || e.conflict) fail(409, "Those records have changed since; revert the later changes first.");
    throw e;
  }
}

// ---------------------------------------------------------------- comments (#6)
async function listComments(c) {
  const g = grantOrFail(c);
  const b = await scoped(c, g);
  const type = c.url.searchParams.get("type") || "person", id = c.url.searchParams.get("id");
  if (!id || !(type === "person" ? b.people[id] : b.families[id])) fail(404, "Not found.");
  const rows = (await c.env.DB.prepare("SELECT * FROM comments WHERE entity_type = ? AND entity_id = ? ORDER BY id").bind(type, id).all()).results;
  return json({ comments: rows });
}
async function addComment(c) {
  const d = await body(c);
  const g = grantOrFail(c, d.tree);
  const b = await scoped(c, g);
  const type = d.type || "person";
  if (!["person", "family"].includes(type) || !d.id || !(type === "person" ? b.people[d.id] : b.families[d.id])) fail(404, "Not found.");
  const text = String(d.body || "").trim();
  if (!text) fail(400, "Empty comment.");
  const row = await c.env.DB.prepare("INSERT INTO comments (entity_type, entity_id, fid, author, body, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *")
    .bind(type, d.id, d.fid || null, self(c), text.slice(0, 8000), now()).first();
  return json({ comment: row }, 201);
}
async function resolveComment(c, id) {
  const row = await c.env.DB.prepare("SELECT * FROM comments WHERE id = ?").bind(id).first();
  if (!row) fail(404, "Not found.");
  const g = grantOrFail(c);
  const b = await scoped(c, g);
  if (!(row.entity_type === "person" ? b.people[row.entity_id] : b.families[row.entity_id])) fail(404, "Not found.");
  if (row.author !== self(c) && !can.review(g)) fail(403, "Only the author or an editor can resolve a comment.");
  await c.env.DB.prepare("UPDATE comments SET resolved_at = ?, resolved_by = ? WHERE id = ?").bind(now(), self(c), id).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------- uploads (#7)
const UPLOAD_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "application/pdf": "pdf" };
async function upload(c) {
  const g = grantOrFail(c);
  if (!c.env.MEDIA) fail(500, "No R2 binding named MEDIA.");
  const type = (c.request.headers.get("Content-Type") || "").split(";")[0].trim();
  if (!UPLOAD_TYPES[type]) fail(415, "Upload a JPEG, PNG, WebP, GIF or PDF.");
  const len = +(c.request.headers.get("Content-Length") || 0);
  if (len > 20 * 1024 * 1024) fail(413, "Files are limited to 20 MB.");
  const buf = await c.request.arrayBuffer();
  if (buf.byteLength > 20 * 1024 * 1024) fail(413, "Files are limited to 20 MB.");
  const name = String(c.url.searchParams.get("name") || "upload").replace(/[^\w.-]+/g, "-").slice(-80);
  const key = `uploads/${now().slice(0, 7)}/${crypto.randomUUID().slice(0, 8)}-${name.replace(/\.[^.]*$/, "")}.${UPLOAD_TYPES[type]}`;
  await c.env.MEDIA.put(key, buf, { httpMetadata: { contentType: type } });
  await c.env.DB.prepare("INSERT INTO uploads (key, uploaded_by, uploaded_at, content_type, bytes, original_name) VALUES (?, ?, ?, ?, ?, ?)").bind(key, self(c), now(), type, buf.byteLength, name).run();
  return json({ key, canAttach: can.review(g) }, 201);
}

// ---------------------------------------------------------------- export (#8)
async function exportGed(c) {
  const g = grantOrFail(c);
  if (!can.review(g)) fail(403, "Only editors and the owner can export.");
  const b = await scoped(c, g); // exactly what the caller can see, living people as their view shows them
  const ged = exportGedcom(b, { title: b.scope.treeName, now: new Date() });
  return new Response(ged, { headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="${g.tree_id}-${now().slice(0, 10)}.ged"`, "Cache-Control": "private, no-store" } });
}
/** GEDCOM X JSON of what the caller can see (docs/design/standards.md). */
async function exportGedcomx(c) {
  const g = grantOrFail(c);
  if (!can.review(g)) fail(403, "Only editors and the owner can export.");
  const b = await scoped(c, g);
  const doc = GedcomX.exportDoc(b, { title: b.scope.treeName });
  return new Response(JSON.stringify(doc), { headers: { "Content-Type": `${GedcomX.MEDIA_TYPE}; charset=utf-8`, "Content-Disposition": `attachment; filename="${g.tree_id}-${now().slice(0, 10)}.gedcomx.json"`, "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" } });
}

/** Owner: see (dry_run, the default) or carry out the move to GEDCOM X storage. */
async function adminStorage(c) {
  if (!can.admin(c.access)) fail(403, "Owner only.");
  const d = await c.request.json().catch(() => ({}));
  const report = await Storage.upgrade(c.env, { dryRun: d.dry_run !== false, actor: self(c) });
  return json({ mode: await Storage.mode(c.env), report }, report.ok || report.already ? 200 : 422);
}

/** Owner: start an empty tree from a GEDCOM X document (another GEDCOM X app, FamilySearch, or our own export). */
async function adminImportGx(c) {
  if (!can.admin(c.access)) fail(403, "Owner only.");
  const doc = await body(c);
  if (!doc || !Array.isArray(doc.persons)) fail(400, "Send a GEDCOM X JSON document (with persons).");
  try { return json({ ok: true, ...(await Storage.importDoc(c.env, doc, { actor: self(c), assignFids })) }, 201); }
  catch (e) { if (e.status) fail(e.status, e.message); throw e; }
}

async function exportJson(c) {
  if (!c.access.isOwner) fail(403, "Only the owner can export the whole database.");
  const st = await loadState(c.env);
  const cfg = Object.fromEntries((await c.env.DB.prepare("SELECT key, value FROM config").all()).results.map((r) => [r.key, parse(r.value)]));
  return json({ format: "family-tree-export/1", exported_at: now(), raw: st.raw, config: cfg, research: st.research },
    200, { "Content-Disposition": `attachment; filename="family-tree-${now().slice(0, 10)}.json"`, "Cache-Control": "private, no-store" });
}

// ---------------------------------------------------------------- graph queries (#15)
async function graph(c, kind) {
  const g = grantOrFail(c);
  const b = await scoped(c, g); // only over what the caller can see: a path never passes through hidden people
  const idx = Graph.buildIndex(b.people, b.families);
  const sp = c.url.searchParams;
  if (kind === "path") {
    const from = sp.get("from") || c.access.personId || b.home, to = sp.get("to");
    if (!b.people[from] || !b.people[to]) fail(404, "Pick two people you can see.");
    const r = Graph.relationshipPath(idx, from, to);
    return json(Object.assign({ from, to }, r, r.found ? { sentence: Graph.explain(r, b.people) } : {}));
  }
  const id = sp.get("id"), n = Math.min(+sp.get("generations") || 4, 12);
  if (!b.people[id]) fail(404, "Not found.");
  return json({ id, [kind]: kind === "ancestors" ? Graph.ancestors(idx, id, n) : Graph.descendants(idx, id, n) });
}

async function linkMe(c) {
  const d = await body(c);
  const g = grantOrFail(c, d.tree);
  const b = await scoped(c, g);
  if (d.person_id && !b.people[d.person_id]) fail(404, "Pick someone in a tree you can see.");
  await write(c.env, [
    c.env.DB.prepare("INSERT INTO members (principal, kind, person_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(principal) DO UPDATE SET person_id = excluded.person_id")
      .bind(self(c), c.access.kind === "agent" ? "agent" : "person", d.person_id || null, now()),
    audit(c.env, { actor: self(c), actorKind: actorKind(c), entityType: "member", entityId: self(c), op: "link-person", after: { person_id: d.person_id || null } }),
  ]);
  return json({ ok: true });
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
  let access = null;
  if (method === "PUT" && d.invite && principal.includes("@")) access = await accessGroup(c.env, principal, "add");
  if (method === "DELETE" && d.revoke_access) {
    const left = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM grants WHERE principal = ?").bind(principal).first();
    if (!left.n) access = await accessGroup(c.env, principal, "remove");
  }
  return json({ ok: true, access });
}

/** Optional: keep the Access group behind the app's policy in sync with invites. Needs CF_API_TOKEN (a token with
 *  only "Access: Organizations, Identity Providers, and Groups: Edit"), CF_ACCOUNT_ID and ACCESS_GROUP_ID. */
async function accessGroup(env, email, action) {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || !env.ACCESS_GROUP_ID) {
    return { automated: false, todo: `Add ${email} to the Access group or policy for this app (Zero Trust → Access → ${action === "add" ? "add" : "remove"} the email). Automate this by setting CF_API_TOKEN, CF_ACCOUNT_ID and ACCESS_GROUP_ID.` };
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/access/groups/${env.ACCESS_GROUP_ID}`;
  const h = { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" };
  const cur = await (await fetch(url, { headers: h })).json();
  if (!cur.success) return { automated: true, ok: false, error: "Couldn't read the Access group." };
  const g = cur.result;
  const has = (g.include || []).some((r) => r.email && r.email.email.toLowerCase() === email);
  if ((action === "add") === has) return { automated: true, ok: true, unchanged: true };
  const include = action === "add" ? [...(g.include || []), { email: { email } }] : (g.include || []).filter((r) => !(r.email && r.email.email.toLowerCase() === email));
  if (!include.length) return { automated: true, ok: false, error: "Refusing to leave the Access group empty." };
  const res = await (await fetch(url, { method: "PUT", headers: h, body: JSON.stringify({ name: g.name, include, exclude: g.exclude || [], require: g.require || [] }) })).json();
  return { automated: true, ok: !!res.success };
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
