// Live token metering per conversation, from Flue's per-model-call `turn` events. Each agent conversation runs in its
// own Durable Object isolate, so this tally is that conversation's own. It drives the per-run cap
// (AGENT_MAX_RUN_TOKENS) while a run is still going; what is recorded in D1 is still each response's total at its end
// (usage.js). One line per model call goes to Workers Logs (token counts only, never content), to see where tokens go.
import { observe } from "@flue/runtime";
import { env } from "cloudflare:workers";
import { settings, tokensOf } from "../../worker/agent/config.js";

const tally = new Map(); // conversation id → budget tokens so far in this isolate

observe((event, ctx) => {
  if (event.type !== "turn" || !event.response || !event.response.usage) return;
  const u = event.response.usage, t = tokensOf(u, settings(env));
  const total = (tally.get(ctx.id) || 0) + t.input + t.output;
  tally.set(ctx.id, total);
  console.log("[turn]", JSON.stringify({ agent: ctx.agentName, id: ctx.id, purpose: event.purpose, input: u.input, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, output: u.output, budget: t.input + t.output, conversation: total }));
});

/** Budget tokens this conversation has used so far (in this isolate's lifetime; a restart starts from zero). */
export const usedTokens = (id) => tally.get(id) || 0;
