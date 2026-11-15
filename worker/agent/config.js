// Settings and budgets for AI work, shared by the site Worker (worker/) and the agents Worker (agents/).
// Everything is a dashboard variable, never a "vars" block in wrangler.jsonc; defaults are deliberately conservative.
// See docs/agents/operations.md → "Cloud research agents".
import { now } from "../db.js";
import { AGENTS, agentModel, costOf } from "./models.js";
export { AGENTS, MODELS, agentModel, modelSpec, compactAt, costOf, modelInfo } from "./models.js";

const int = (v, d) => (Number.isFinite(+v) && +v > 0 ? Math.floor(+v) : d);

const usd = (v, d) => (v !== undefined && v !== "" && Number.isFinite(+v) && +v >= 0 ? +v : d);

export function settings(env) {
  return {
    // Which model and effort each agent uses: worker/agent/models.js (AI_MODEL_<AGENT>, AI_EFFORT_<AGENT>).
    agents: Object.fromEntries(Object.keys(AGENTS).map((k) => [k, agentModel(env, k)])),
    gateway: env.AI_GATEWAY_ID || "default",
    gatewayLogs: env.AI_GATEWAY_LOGS !== "false",         // gateway logs on (they include prompts, i.e. family data); "false" turns them off
    searchProvider: env.WEB_SEARCH_PROVIDER || "exa",     // Cloudflare Web Search API: needs AI Gateway credits…
    searchByokAlias: env.WEB_SEARCH_BYOK_ALIAS || undefined, // …or a search provider key stored on the gateway, by alias
    maxSearches: int(env.AGENT_MAX_SEARCHES, 25),          // web searches per run
    maxFetches: int(env.AGENT_MAX_FETCHES, 40),            // pages read per run
    maxMinutes: int(env.AGENT_MAX_MINUTES, 45),            // wall clock per run (Flue durability timeout)
    maxRunsPerDay: int(env.AGENT_MAX_RUNS_PER_DAY, 50),
    // Budgets are in US dollars, priced per model (models.js), so they mean the same whichever models the agents use.
    dailyUsd: usd(env.AI_DAILY_BUDGET_USD, 5),            // agent runs and the content job together, per day
    chatDailyUsd: usd(env.AI_CHAT_DAILY_BUDGET_USD, 1),    // the page assistant's own allowance, so a heavy run can't
                                                          // lock editors out of the chat
    runUsd: usd(env.AGENT_MAX_RUN_USD, 1),                 // one run stops and submits what it has past this
    contentPerRun: int(env.CONTENT_MAX_PER_RUN, 50),
    contentEnabled: env.CONTENT_JOB_ENABLED === "true",
  };
}

/** The site Worker reaches the agents Worker through a service binding named AGENTS. */
export const agentsEnabled = (env) => !!(env.AGENTS && typeof env.AGENTS.fetch === "function");

export class BudgetError extends Error {}

const today = () => now().slice(0, 10);
// One ai_usage row per day for agent work, and a separate "chat:<day>" row for the page assistant's allowance.
const dayKey = (chat) => (chat ? `chat:${today()}` : today());

export async function usageToday(env, { chat = false } = {}) {
  return (await env.DB.prepare("SELECT runs, input_tokens, output_tokens, cost_usd FROM ai_usage WHERE day = ?").bind(dayKey(chat)).first())
    || { runs: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
}

const money = (x) => "$" + (+x).toFixed(2);

/** Throws BudgetError when today's spend (the assistant's own allowance with chat: true; with runs: true, also the
 *  run count) is used up. */
export async function checkDaily(env, s = settings(env), { runs = false, chat = false } = {}) {
  const u = await usageToday(env, { chat });
  const limit = chat ? s.chatDailyUsd : s.dailyUsd;
  if ((u.cost_usd || 0) >= limit) throw new BudgetError(`Today's AI budget${chat ? " for the assistant" : ""} (${money(limit)}) is used up. It resets at midnight UTC.`);
  if (runs && u.runs >= s.maxRunsPerDay) throw new BudgetError(`The daily limit of ${s.maxRunsPerDay} agent runs is reached. It resets at midnight UTC.`);
  return u;
}

export const recordUsage = (env, { input = 0, output = 0, cost = 0, runs = 0, chat = false }) =>
  env.DB.prepare("INSERT INTO ai_usage (day, runs, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?) ON CONFLICT(day) DO UPDATE SET runs = runs + excluded.runs, input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens, cost_usd = cost_usd + excluded.cost_usd")
    .bind(dayKey(chat), runs, input, output, cost);

/** Flue's PromptUsage for `modelId` -> {input (all input, cached included), output, cost in USD}. */
export const usageOf = (u = {}, modelId) => ({
  input: (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0),
  output: u.output || 0,
  cost: costOf(u, modelId),
});
