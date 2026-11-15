// Which model each agent uses, and what the models cost. See docs/agents/models.md for why each default was chosen.
//
// Every agent's model and effort is a dashboard variable: AI_MODEL_<AGENT> and AI_EFFORT_<AGENT>, e.g.
// AI_MODEL_STORIES=anthropic/claude-sonnet-5-5. AI_MODEL (and the older AI_EFFORT, AI_CHAT_EFFORT, AI_CONTENT_EFFORT)
// still apply as fallbacks. Ids are Workers AI ids (@cf/…, billed to the Workers plan) or AI Gateway ids
// (anthropic/…, openai/…, which need gateway credits or a provider key stored on the gateway).

/** Published prices (USD per million tokens) and context windows, from the Workers AI and AI Gateway catalogs.
 *  `effort` lists the effort levels the model really has; others are raised to the next one up by Pi. */
export const MODELS = {
  "@cf/deepseek-ai/deepseek-v4.1-flash-1017": { window: 1048576, input: 0.30, output: 1.20, cacheRead: 0.006, effort: ["off", "high", "max"] },
  "@cf/zai-org/glm-5.3": { window: 1048576, input: 1.40, output: 4.40, cacheRead: 0.26, effort: ["low", "high", "max"] },
  "@cf/qwen/qwen3.8-27b": { window: 262144, input: 0.45, output: 3.20, cacheRead: 0.05, effort: ["low", "medium", "xhigh"] },
  "@cf/google/gemma-4-26b-a4b-it": { window: 256000, input: 0.10, output: 0.30, cacheRead: 0.10 },
  "@cf/openai/gpt-oss-120b": { window: 128000, input: 0.35, output: 0.75, cacheRead: 0.35, effort: ["low", "medium", "high"] },
  "@cf/zai-org/glm-4.7-flash": { window: 131072, input: 0.0605, output: 0.40, cacheRead: 0.0605 },
  // newer than the model catalog in our pinned Pi: Flue runs it, but without context-window or effort metadata
  "@cf/thinkingmachines/inkling-2-small": { window: 1048576, input: 0.30, output: 1.00, cacheRead: 0.10, uncatalogued: true },
  // retiring on Workers AI: requests fail with 410 from 2026-11-20
  "@cf/moonshotai/kimi-k2.6": { window: 262144, input: 0.95, output: 4.00, cacheRead: 0.16, retires: "2026-11-20" },
  "@cf/moonshotai/kimi-k2.7-code": { window: 262144, input: 0.95, output: 4.00, cacheRead: 0.19, retires: "2026-11-20" },
  "@cf/zai-org/glm-5.3-flash": { window: 1048576, input: 0.15, output: 0.50, cacheRead: 0.03, retires: "2026-11-20" },
  // through AI Gateway (needs gateway credits or a stored provider key)
  "anthropic/claude-sonnet-5-5": { window: 1000000, input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, gateway: true },
  "anthropic/claude-haiku-5-5": { window: 1000000, input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, gateway: true },
  "anthropic/claude-opus-5-5": { window: 1000000, input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, gateway: true },
};

/** Prices assumed for a model not in the table, so the budget errs on the safe side. */
const UNKNOWN = { window: 131072, input: 2, output: 10, cacheRead: 0.2 };
export const modelInfo = (id) => MODELS[id] || UNKNOWN;

/** The agents and their defaults. `legacy` names the older effort variable each one used to follow. */
export const AGENTS = {
  research: { model: "@cf/deepseek-ai/deepseek-v4.1-flash-1017", effort: "high", legacy: "AI_EFFORT" },
  chat: { model: "@cf/deepseek-ai/deepseek-v4.1-flash-1017", effort: "high", legacy: "AI_CHAT_EFFORT" },
  quality: { model: "@cf/deepseek-ai/deepseek-v4.1-flash-1017", effort: "high", legacy: "AI_CONTENT_EFFORT" },
  stories: { model: "@cf/zai-org/glm-5.3", effort: "high", legacy: "AI_CONTENT_EFFORT" },
  library: { model: "@cf/deepseek-ai/deepseek-v4.1-flash-1017", effort: "high", legacy: "AI_CONTENT_EFFORT" }, // the quality reviewer's model
  profiles: { model: "@cf/qwen/qwen3.8-27b", effort: "low", legacy: "AI_CONTENT_EFFORT" },
  story_checks: { model: "@cf/qwen/qwen3.8-27b", effort: "medium", legacy: "AI_CONTENT_EFFORT" },
};
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** {model, effort} for one agent from the dashboard variables, falling back to the defaults above. */
export function agentModel(env, agent) {
  const d = AGENTS[agent];
  if (!d) throw new Error(`unknown agent ${agent}`);
  const key = agent.toUpperCase();
  const model = String(env[`AI_MODEL_${key}`] || env.AI_MODEL || d.model).trim();
  const e = String(env[`AI_EFFORT_${key}`] || env[d.legacy] || d.effort).trim();
  return { model, effort: LEVELS.includes(e) ? e : d.effort };
}

/** The Flue model specifier: everything goes through the Workers AI binding (and AI Gateway). */
export const modelSpec = (id) => `cloudflare/${id}`;

/**
 * What one response cost, in USD. Flue computes it from Pi's catalog when it knows the model; otherwise (a model
 * newer than the catalog) it comes from the table above, or the cautious UNKNOWN prices.
 */
export function costOf(usage = {}, modelId) {
  const flue = usage.cost && usage.cost.total;
  if (flue > 0) return flue;
  const m = modelInfo(modelId);
  return ((usage.input || 0) * m.input + (usage.output || 0) * m.output + (usage.cacheRead || 0) * (m.cacheRead ?? m.input)
    + (usage.cacheWrite || 0) * (m.cacheWrite ?? m.input)) / 1e6;
}

/**
 * Flue compaction settings that summarise older context once the conversation passes `target` tokens (every model
 * call re-sends the whole conversation), instead of waiting until it nears the model's window.
 */
export const compactAt = (modelId, target, keepRecentTokens) => ({
  reserveTokens: Math.max(20000, modelInfo(modelId).window - target),
  keepRecentTokens,
});
