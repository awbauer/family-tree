// Settings and budgets for AI work, shared by the site Worker (worker/) and the agents Worker (agents/).
// Everything is a dashboard variable, never a "vars" block in wrangler.jsonc; defaults are deliberately conservative.
// See docs/agents/operations.md → "Cloud research agents".
import { now } from "../db.js";

const int = (v, d) => (Number.isFinite(+v) && +v > 0 ? Math.floor(+v) : d);

export function settings(env) {
  return {
    // AI Gateway catalog id (Workers AI binding → AI Gateway → Anthropic). Billed to gateway credits or a key stored on the gateway.
    model: env.AI_MODEL || "anthropic/claude-opus-5.5",
    effort: env.AI_EFFORT || "high",                      // research runs (Flue thinkingLevel)
    contentEffort: env.AI_CONTENT_EFFORT || "medium",     // profiles and story checks
    gateway: env.AI_GATEWAY_ID || "default",
    gatewayLogs: env.AI_GATEWAY_LOGS === "true",          // prompts hold family data: no gateway logs unless debugging
    searchProvider: env.WEB_SEARCH_PROVIDER || "exa",
    maxSearches: int(env.AGENT_MAX_SEARCHES, 25),          // web searches per run
    maxFetches: int(env.AGENT_MAX_FETCHES, 40),            // pages read per run
    maxMinutes: int(env.AGENT_MAX_MINUTES, 45),            // wall clock per run (Flue durability timeout)
    maxRunsPerDay: int(env.AGENT_MAX_RUNS_PER_DAY, 10),
    dailyTokens: int(env.AI_DAILY_TOKEN_BUDGET, 4000000),  // all AI work together
    contentPerRun: int(env.CONTENT_MAX_PER_RUN, 20),
    contentEnabled: env.CONTENT_JOB_ENABLED === "true",
  };
}

/** The site Worker reaches the agents Worker through a service binding named AGENTS. */
export const agentsEnabled = (env) => !!(env.AGENTS && typeof env.AGENTS.fetch === "function");

export class BudgetError extends Error {}

const today = () => now().slice(0, 10);

export async function usageToday(env) {
  return (await env.DB.prepare("SELECT runs, input_tokens, output_tokens FROM ai_usage WHERE day = ?").bind(today()).first())
    || { runs: 0, input_tokens: 0, output_tokens: 0 };
}

/** Throws BudgetError when today's shared token budget (or, with runs: true, the run count) is used up. */
export async function checkDaily(env, s = settings(env), { runs = false } = {}) {
  const u = await usageToday(env);
  if (u.input_tokens + u.output_tokens >= s.dailyTokens) throw new BudgetError(`Today's AI budget (${s.dailyTokens.toLocaleString("en")} tokens) is used up. It resets at midnight UTC.`);
  if (runs && u.runs >= s.maxRunsPerDay) throw new BudgetError(`The daily limit of ${s.maxRunsPerDay} research runs is reached. It resets at midnight UTC.`);
  return u;
}

export const recordUsage = (env, { input = 0, output = 0, runs = 0 }) =>
  env.DB.prepare("INSERT INTO ai_usage (day, runs, input_tokens, output_tokens) VALUES (?, ?, ?, ?) ON CONFLICT(day) DO UPDATE SET runs = runs + excluded.runs, input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens")
    .bind(today(), runs, input, output);

/** Flue's PromptUsage → {input, output}; cache reads and writes count as input so the budget is conservative. */
export const tokensOf = (u = {}) => ({ input: (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0), output: u.output || 0 });
