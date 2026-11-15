// Settings and budgets for AI work, shared by the site Worker (worker/) and the agents Worker (agents/).
// Everything is a dashboard variable, never a "vars" block in wrangler.jsonc; defaults are deliberately conservative.
// See docs/agents/operations.md → "Cloud research agents".
import { now } from "../db.js";

const int = (v, d) => (Number.isFinite(+v) && +v > 0 ? Math.floor(+v) : d);
const frac = (v, d) => (v !== undefined && v !== "" && Number.isFinite(+v) && +v >= 0 && +v <= 1 ? +v : d);

export function settings(env) {
  return {
    // Model id for the Workers AI binding. The default runs on Workers AI (billed to the Workers plan, with a daily
    // free allocation). A gateway model such as "anthropic/claude-opus-5-5" needs AI Gateway credits or a provider key
    // stored on the gateway.
    model: env.AI_MODEL || "@cf/moonshotai/kimi-k2.6",
    effort: env.AI_EFFORT || "high",                      // research runs (Flue thinkingLevel)
    contentEffort: env.AI_CONTENT_EFFORT || "medium",     // profiles and story checks
    chatEffort: env.AI_CHAT_EFFORT || "low",              // the page assistant: quick replies
    gateway: env.AI_GATEWAY_ID || "default",
    gatewayLogs: env.AI_GATEWAY_LOGS !== "false",         // gateway logs on (they include prompts, i.e. family data); "false" turns them off
    searchProvider: env.WEB_SEARCH_PROVIDER || "exa",     // Cloudflare Web Search API: needs AI Gateway credits…
    searchByokAlias: env.WEB_SEARCH_BYOK_ALIAS || undefined, // …or a search provider key stored on the gateway, by alias
    maxSearches: int(env.AGENT_MAX_SEARCHES, 25),          // web searches per run
    maxFetches: int(env.AGENT_MAX_FETCHES, 40),            // pages read per run
    maxMinutes: int(env.AGENT_MAX_MINUTES, 45),            // wall clock per run (Flue durability timeout)
    maxRunsPerDay: int(env.AGENT_MAX_RUNS_PER_DAY, 10),
    dailyTokens: int(env.AI_DAILY_TOKEN_BUDGET, 10000000), // research runs, the content job and other agent runs, per day
    chatDailyTokens: int(env.AI_CHAT_DAILY_TOKENS, 2000000), // the page assistant has its own daily allowance, so a
                                                          // heavy research run can't lock editors out of the chat
    runTokens: int(env.AGENT_MAX_RUN_TOKENS, 1500000),     // one research run stops and submits what it has past this
    // Budget tokens count a cached input token at this fraction of a fresh one (Kimi K2.6 on Workers AI: $0.16/M cached
    // vs $0.95/M fresh input), so re-sent, cached context doesn't use the budget up at full price.
    cacheReadWeight: frac(env.AI_CACHE_READ_WEIGHT, 0.17),
    contextWindow: int(env.AI_CONTEXT_WINDOW, 262144),     // the model's context window, for early compaction
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
  return (await env.DB.prepare("SELECT runs, input_tokens, output_tokens FROM ai_usage WHERE day = ?").bind(dayKey(chat)).first())
    || { runs: 0, input_tokens: 0, output_tokens: 0 };
}

/** Throws BudgetError when today's token budget (the assistant's own with chat: true; with runs: true, also the
 *  run count) is used up. */
export async function checkDaily(env, s = settings(env), { runs = false, chat = false } = {}) {
  const u = await usageToday(env, { chat });
  const limit = chat ? s.chatDailyTokens : s.dailyTokens;
  if (u.input_tokens + u.output_tokens >= limit) throw new BudgetError(`Today's AI budget${chat ? " for the assistant" : ""} (${limit.toLocaleString("en")} tokens) is used up. It resets at midnight UTC.`);
  if (runs && u.runs >= s.maxRunsPerDay) throw new BudgetError(`The daily limit of ${s.maxRunsPerDay} agent runs is reached. It resets at midnight UTC.`);
  return u;
}

export const recordUsage = (env, { input = 0, output = 0, runs = 0, chat = false }) =>
  env.DB.prepare("INSERT INTO ai_usage (day, runs, input_tokens, output_tokens) VALUES (?, ?, ?, ?) ON CONFLICT(day) DO UPDATE SET runs = runs + excluded.runs, input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens")
    .bind(dayKey(chat), runs, input, output);

/** Flue's PromptUsage → budget tokens {input, output}: fresh input and cache writes at full weight, cache reads at
 *  cacheReadWeight. */
export const tokensOf = (u = {}, s = { cacheReadWeight: 0.17 }) => ({
  input: (u.input || 0) + (u.cacheWrite || 0) + Math.round((u.cacheRead || 0) * s.cacheReadWeight),
  output: u.output || 0,
});

/** Flue compaction settings that summarise older context once the conversation passes `target` tokens, instead of
 *  waiting until it nears the model's whole window (every model call re-sends the whole context). */
export const compactAt = (s, target, keepRecentTokens) => ({
  reserveTokens: Math.max(20000, s.contextWindow - target),
  keepRecentTokens,
});
