// HTTP routes for cloud research runs and AI-maintained content. Editors and the owner start runs; the agent works
// in the starter's scope and only ever produces suggestions. The agents themselves live in a separate, private
// Worker (agents/, built with Flue) that this Worker reaches through the AGENTS service binding; it has no public URL.
//
//   POST /api/agent/runs               {tree, todo_id?, person?, instructions?}  start a run (editors)
//   GET  /api/agent/runs?tree=         recent runs in this tree (editors)
//   GET  /api/agent/runs/:id           one run: status, step log, tokens, resulting suggestions (editors)
//   POST /api/agent/runs/:id/cancel    stop a run and release its to-do (editors)
//   POST /api/profiles/:id/refresh     queue a rewrite of one person's AI profile (editors)
//   POST /api/content/refresh          run the content job now (owner)
import { J, now, parse, write } from "../db.js";
import { can, grantFor } from "../auth.js";
import { fail, json } from "../http.js";
import { settings, agentsEnabled, checkDaily, recordUsage, usageToday, BudgetError } from "./config.js";
import { AGENT, RESEARCHER_PATH, firstMessage, endRun } from "./runs.js";

export const enabled = agentsEnabled;

/** Call the agents Worker over the service binding. The host is a placeholder; only the path matters. */
export async function agentsFetch(env, path, body, method = "POST") {
  const headers = { "Content-Type": "application/json" };
  if (env.AGENTS_TOKEN) headers["X-Agents-Token"] = env.AGENTS_TOKEN;
  const res = await env.AGENTS.fetch(new Request(`https://agents.internal${path}`, { method, headers, body: body === undefined ? undefined : J(body) }));
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { text }; }
  if (!res.ok) throw Object.assign(new Error(data.error || data.message || `agents Worker answered ${res.status}`), { status: res.status });
  return data;
}

function editorOnly(c, g) {
  if (!can.review(g) || c.access.kind === "agent") fail(403, "Only editors can run research agents.");
}
function needAgents(c) {
  if (!agentsEnabled(c.env)) fail(503, "Research agents aren't set up yet: deploy the agents Worker and add the AGENTS service binding. See docs/agents/operations.md → Cloud research agents.");
}

const runOut = (r) => ({
  id: r.id, tree: r.tree_id, todo_id: r.todo_id, person: r.person_id, started_by: r.started_by, instructions: r.instructions,
  status: r.status, steps: r.steps, tokens: { input: r.input_tokens, output: r.output_tokens }, model: r.model,
  log: parse(r.log, []), proposals: parse(r.proposal_ids, []), error: r.error,
  created_at: r.created_at, started_at: r.started_at, finished_at: r.finished_at,
});

export async function startRun(c, d, { grantOrFail, scoped, loadTodo }) {
  const g = grantOrFail(c, d.tree);
  editorOnly(c, g);
  needAgents(c);
  const env = c.env, s = settings(env), b = await scoped(c, g);
  let todo = null;
  if (d.todo_id) {
    todo = (await loadTodo(c, d.todo_id)).row;
    if (["done", "wont_do"].includes(todo.status)) fail(409, "That to-do is closed.");
    if (todo.assignee === AGENT) fail(409, "A research agent is already working on that to-do.");
    if (todo.assignee && todo.assignee !== c.access.principal) fail(409, `That to-do is assigned to ${todo.assignee}. Unassign it first.`);
  }
  const person = d.person || (todo && todo.person_id) || null;
  if (person) {
    const p = b.people[person];
    if (!p) fail(404, "That person isn't in this tree.");
    if (p.living || p.private) fail(400, "Research runs are for people who have died. Living people aren't researched.");
  }
  const instructions = String(d.instructions || "").trim().slice(0, 2000) || null;
  if (!todo && !person && (!instructions || instructions.length < 10)) fail(400, "Give a to-do, a person, or instructions saying what to research.");
  try { await checkDaily(env, s, { runs: true }); } catch (e) { if (e instanceof BudgetError) fail(429, e.message); throw e; }

  const id = `run-${now().slice(0, 10).replace(/-/g, "")}-${crypto.randomUUID().slice(0, 8)}`;
  const t = now();
  const st = [
    env.DB.prepare("INSERT INTO agent_runs (id, todo_id, person_id, tree_id, started_by, instructions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, todo ? todo.id : null, person, g.tree_id, c.access.principal, instructions, t),
    recordUsage(env, { runs: 1 }),
  ];
  if (todo) {
    st.push(env.DB.prepare("UPDATE todos SET assignee = ?, status = 'in_progress', updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ? AND version = ?").bind(AGENT, t, c.access.principal, todo.id, todo.version));
    st.push(env.DB.prepare("INSERT INTO todo_events (todo_id, at, actor, kind, data) VALUES (?, ?, ?, 'assigned', ?)").bind(todo.id, t, c.access.principal, J({ from: todo.assignee, to: AGENT, run: id })));
  }
  const res = await write(env, st);
  if (todo && res[2].meta && res[2].meta.changes === 0) {
    await endRun(env, id, "the to-do changed while starting", "cancelled");
    fail(409, "Someone changed that to-do meanwhile. Reload and try again.");
  }
  // Hand the run to its own Flue agent conversation (one Durable Object per run, id = run id). Admission is durable:
  // once this returns, the agent owes the run an outcome even across restarts.
  try {
    await agentsFetch(env, `${RESEARCHER_PATH}/${id}`, { kind: "user", body: firstMessage({ instructions, person }, b, todo), initialData: { runId: id } });
  } catch (e) {
    await endRun(env, id, `the agents Worker didn't accept the run: ${e.message}`);
    fail(502, `Couldn't start the run: ${e.message}`);
  }
  return json({ run: runOut(await env.DB.prepare("SELECT * FROM agent_runs WHERE id = ?").bind(id).first()) }, 201);
}

/** A run whose agent hit Flue's time limit never reaches its finish hook: close it here, lazily, on read. */
async function sweepStale(env) {
  const s = settings(env);
  const cutoff = new Date(Date.now() - (s.maxMinutes + 15) * 60000).toISOString();
  const stale = (await env.DB.prepare("SELECT id FROM agent_runs WHERE status IN ('queued', 'running') AND created_at < ?").bind(cutoff).all()).results;
  for (const r of stale) await endRun(env, r.id, `timed out after ${s.maxMinutes} minutes`);
}

export async function listRuns(c, { grantOrFail }) {
  const g = grantOrFail(c);
  editorOnly(c, g);
  await sweepStale(c.env);
  const rows = (await c.env.DB.prepare("SELECT * FROM agent_runs WHERE tree_id = ? ORDER BY created_at DESC LIMIT 50").bind(g.tree_id).all()).results;
  const person = c.url.searchParams.get("person");
  const u = await usageToday(c.env).catch(() => null);
  const s = settings(c.env);
  return json({
    runs: rows.filter((r) => !person || r.person_id === person).map(runOut),
    today: u && { runs: u.runs, tokens: u.input_tokens + u.output_tokens },
    limits: { runs_per_day: s.maxRunsPerDay, tokens_per_day: s.dailyTokens, searches_per_run: s.maxSearches, minutes_per_run: s.maxMinutes, model: s.model },
  });
}

async function runFor(c, id) {
  const r = await c.env.DB.prepare("SELECT * FROM agent_runs WHERE id = ?").bind(id).first();
  const g = r && grantFor(c.access, r.tree_id);
  if (!r || !g) fail(404, "No such run.");
  editorOnly(c, g);
  return r;
}

export async function getRun(c, id) {
  await sweepStale(c.env);
  return json({ run: runOut(await runFor(c, id)) });
}

export async function cancel(c, id) {
  const r = await runFor(c, id);
  if (!["queued", "running"].includes(r.status)) fail(409, "That run has already finished.");
  if (agentsEnabled(c.env)) await agentsFetch(c.env, `${RESEARCHER_PATH}/${id}/abort`, {}).catch(() => null);
  await endRun(c.env, id, `cancelled by ${c.access.principal}`, "cancelled");
  return json({ ok: true });
}

export async function refreshProfileRoute(c, id, { grantOrFail, scoped }) {
  const g = grantOrFail(c);
  editorOnly(c, g);
  needAgents(c);
  const b = await scoped(c, g);
  const p = b.people[id];
  if (!p) fail(404, "Not found.");
  if (p.living || p.private) fail(400, "Profiles are only written for people who have died.");
  try { await checkDaily(c.env); } catch (e) { if (e instanceof BudgetError) fail(429, e.message); throw e; }
  const r = await agentsFetch(c.env, "/internal/profiles", { person: id, force: true });
  return json({ ok: true, queued: r }, 202);
}

export async function refreshContent(c) {
  if (!c.access.isOwner) fail(403, "Owner only.");
  needAgents(c);
  return json(await agentsFetch(c.env, "/internal/content/refresh", { by: c.access.principal }), 202);
}
