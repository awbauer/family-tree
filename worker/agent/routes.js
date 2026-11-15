// HTTP routes for cloud research runs and AI-maintained content. Editors and the owner start runs; the agent works
// in the starter's scope and only ever produces suggestions. The agents themselves live in a separate, private
// Worker (agents/, built with Flue) that this Worker reaches through the AGENTS service binding; it has no public URL.
//
//   POST /api/agent/runs               {tree, todo_id?, person?, instructions?}  start a run (editors)
//   GET  /api/agent/runs?tree=         recent runs in this tree (editors)
//   GET  /api/agent/runs/:id           one run: status, step log, tokens, resulting suggestions (editors)
//   POST /api/agent/runs/:id/cancel    stop a run and release its to-do (editors)
//   POST /api/agent/runs               {tree, kind: "quality", scope?, person?, limit?, dry_run?}  a data quality review
//   POST /api/agent/runs/:id/apply     apply a finished dry-run review's decisions (editors)
//   POST /api/agent/runs               {tree, kind: "story", mode: "review", slug, instructions?}
//                                      {tree, kind: "story", mode: "draft", people: [ids], instructions?, length?}
//   POST /api/profiles/:id/refresh     queue a rewrite of one person's AI profile (editors)
//   POST /api/content/refresh          run the content job now (owner)
import { J, now, parse, write } from "../db.js";
import { can, grantFor } from "../auth.js";
import { fail, json } from "../http.js";
import { settings, agentsEnabled, checkDaily, recordUsage, usageToday, BudgetError } from "./config.js";
import { AGENT, RESEARCHER_PATH, firstMessage, endRun } from "./runs.js";
import * as Quality from "./quality.js";
import * as Stories from "./stories.js";

/** Where each kind of run's agent is mounted in the agents Worker. */
const PATHS = { research: RESEARCHER_PATH, quality: Quality.QUALITY_PATH, story: Stories.STORY_PATH };

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

const runOut = (r) => {
  const opts = parse(r.options, null);
  return {
  id: r.id, kind: r.kind || "research", tree: r.tree_id, todo_id: r.todo_id, person: r.person_id, started_by: r.started_by, instructions: r.instructions,
  options: opts ? { ...opts, items: undefined, count: (opts.items || []).length } : undefined,
  report: r.report ? parse(r.report, []) : undefined, summary: (parse(r.result, {}) || {}).summary,
  status: r.status, steps: r.steps, tokens: { input: r.input_tokens, output: r.output_tokens }, usd: r.cost_usd || 0, model: r.model,
  log: parse(r.log, []), proposals: parse(r.proposal_ids, []), error: r.error,
  created_at: r.created_at, started_at: r.started_at, finished_at: r.finished_at,
  };
};

export async function startRun(c, d, { grantOrFail, scoped, loadTodo }) {
  const g = grantOrFail(c, d.tree);
  editorOnly(c, g);
  needAgents(c);
  if (d.kind === "quality") return startQuality(c, d, g, { scoped });
  if (d.kind === "story") return startStory(c, d, g, { scoped });
  if (d.kind && d.kind !== "research") fail(400, "kind must be research, quality or story");
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
    today: u && { runs: u.runs, usd: u.cost_usd || 0, tokens: u.input_tokens + u.output_tokens },
    limits: { runs_per_day: s.maxRunsPerDay, usd_per_day: s.dailyUsd, usd_per_run: s.runUsd, searches_per_run: s.maxSearches, minutes_per_run: s.maxMinutes, agents: s.agents },
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
  if (agentsEnabled(c.env)) await agentsFetch(c.env, `${PATHS[r.kind] || RESEARCHER_PATH}/${id}/abort`, {}).catch(() => null);
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

// ---------------------------------------------------------------- data quality review (#31)
async function startQuality(c, d, g, { scoped }) {
  const env = c.env, s = settings(env), b = await scoped(c, g);
  const scope = Quality.SCOPES.includes(d.scope) ? d.scope : "both";
  const person = d.person ? String(d.person) : null;
  if (person && !b.people[person]) fail(404, "That person isn't in this tree.");
  const limit = Math.max(1, Math.min(Quality.MAX_ITEMS, parseInt(d.limit, 10) || 10));
  const dryRun = d.dry_run !== false; // dry run unless asked otherwise
  const items = Quality.planItems(b, { scope, person, limit, starter: c.access.principal });
  if (!items.length) fail(400, "There are no open items to review with those options.");
  try { await checkDaily(env, s, { runs: true }); } catch (e) { if (e instanceof BudgetError) fail(429, e.message); throw e; }
  const id = `run-${now().slice(0, 10).replace(/-/g, "")}-${crypto.randomUUID().slice(0, 8)}`;
  const options = { scope, person, limit, dry_run: dryRun, items };
  await write(env, [
    env.DB.prepare("INSERT INTO agent_runs (id, kind, person_id, tree_id, started_by, instructions, options, report, created_at) VALUES (?, 'quality', ?, ?, ?, ?, ?, '[]', ?)")
      .bind(id, person, g.tree_id, c.access.principal, `Data quality review of ${items.length} item${items.length === 1 ? "" : "s"}${dryRun ? " (dry run)" : ""}`, J(options), now()),
    recordUsage(env, { runs: 1 }),
  ]);
  try {
    await agentsFetch(env, `${Quality.QUALITY_PATH}/${id}`, { kind: "user", body: Quality.firstMessage(b, options, items), initialData: { runId: id } });
  } catch (e) {
    await endRun(env, id, `the agents Worker didn't accept the run: ${e.message}`);
    fail(502, `Couldn't start the review: ${e.message}`);
  }
  return json({ run: runOut(await env.DB.prepare("SELECT * FROM agent_runs WHERE id = ?").bind(id).first()) }, 201);
}

export async function applyRun(c, id) {
  const r = await runFor(c, id);
  if (r.kind !== "quality") fail(400, "Only a data quality review can be applied.");
  if (r.status !== "succeeded") fail(409, "Wait for the review to finish.");
  try {
    const report = await Quality.applyReport(c.env, r, c.access.principal);
    return json({ ok: true, report, run: runOut(await c.env.DB.prepare("SELECT * FROM agent_runs WHERE id = ?").bind(id).first()) });
  } catch (e) { if (e.status) fail(e.status, e.message); throw e; }
}

// ---------------------------------------------------------------- stories (#33)
async function startStory(c, d, g, { scoped }) {
  const env = c.env, s = settings(env), b = await scoped(c, g);
  const mode = d.mode === "review" ? "review" : d.mode === "draft" ? "draft" : fail(400, "mode must be review or draft");
  const instructions = String(d.instructions || "").trim().slice(0, 2000) || null;
  const o = { mode, instructions };
  if (mode === "review") {
    const st = (b.research.stories || []).find((x) => x.slug === d.slug);
    if (!st) fail(404, "No such story.");
    o.slug = st.slug;
  } else {
    const people = [...new Set((Array.isArray(d.people) ? d.people : []).map(String))].slice(0, 12);
    if (!people.length) fail(400, "Choose who the story is about.");
    for (const pid of people) {
      const p = b.people[pid];
      if (!p) fail(404, `${pid} isn't in this tree.`);
      if (p.living || p.private) fail(400, `${p.name} is living. Stories are about people who have died; living relatives can be mentioned by name.`);
    }
    o.people = people;
    o.length = Stories.LENGTHS[d.length] ? d.length : "medium";
  }
  try { await checkDaily(env, s, { runs: true }); } catch (e) { if (e instanceof BudgetError) fail(429, e.message); throw e; }
  const id = `run-${now().slice(0, 10).replace(/-/g, "")}-${crypto.randomUUID().slice(0, 8)}`;
  const label = mode === "review" ? `Review the story “${(b.research.stories.find((x) => x.slug === o.slug) || {}).title}”` : `Draft a ${o.length} story about ${o.people.map((x) => b.people[x].name).join(", ")}`;
  await write(env, [
    env.DB.prepare("INSERT INTO agent_runs (id, kind, person_id, tree_id, started_by, instructions, options, created_at) VALUES (?, 'story', ?, ?, ?, ?, ?, ?)")
      .bind(id, mode === "draft" ? o.people[0] : null, g.tree_id, c.access.principal, `${label}${instructions ? `: ${instructions}` : ""}`, J(o), now()),
    recordUsage(env, { runs: 1 }),
  ]);
  try {
    await agentsFetch(env, `${Stories.STORY_PATH}/${id}`, { kind: "user", body: Stories.firstMessage(b, o), initialData: { runId: id } });
  } catch (e) {
    await endRun(env, id, `the agents Worker didn't accept the run: ${e.message}`);
    fail(502, `Couldn't start the run: ${e.message}`);
  }
  return json({ run: runOut(await env.DB.prepare("SELECT * FROM agent_runs WHERE id = ?").bind(id).first()) }, 201);
}
