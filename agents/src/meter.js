// Live spend per conversation, from Flue's per-model-call `turn` events. Each agent conversation runs in its own
// Durable Object isolate, so this tally is that conversation's own. It drives the per-run cap (AGENT_MAX_RUN_USD)
// while a run is still going; what is recorded in D1 is still each response's total at its end (usage.js). One line
// per model call goes to Workers Logs (model and token counts only, never content), to see where the money goes.
import { observe } from "@flue/runtime";
import { costOf } from "../../worker/agent/models.js";

const tally = new Map(); // conversation id -> USD so far in this isolate

observe((event, ctx) => {
  if (event.type !== "turn" || !event.response || !event.response.usage) return;
  const u = event.response.usage, model = (event.request && event.request.requestedModel) || event.response.responseModel;
  const cost = costOf(u, model);
  const total = (tally.get(ctx.id) || 0) + cost;
  tally.set(ctx.id, total);
  console.log("[turn]", JSON.stringify({ agent: ctx.agentName, id: ctx.id, model, purpose: event.purpose, input: u.input, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, output: u.output, usd: +cost.toFixed(5), conversationUsd: +total.toFixed(4) }));
});

/** USD this conversation has spent so far (in this isolate's lifetime; a restart starts from zero). */
export const usedUsd = (id) => tally.get(id) || 0;
