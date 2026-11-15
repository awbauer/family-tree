// A custom hook (not an agent): report each response's token use and cost once, as a delta, so the run and the daily
// budget in D1 match what was billed. Flue's finish seam is at-least-once; the persisted high-water mark keeps a
// re-run from counting the same usage twice.
import { useAgentFinish, useAgentStart, usePersistentState } from "@flue/runtime";
import { usageOf } from "../../../worker/agent/config.js";

/**
 * `record({input, output, cost}, model)` is called with each new increment for the agent's `model`.
 * `perDelivery: true` for a conversation where each delivered message starts a new response (the page assistant): a
 * response's usage counts from zero, so the high-water mark resets when a message arrives. State names must be unique
 * within a render, so this hook owns "usage_recorded"; agents must not declare it themselves.
 */
export function useUsage(record, { model, perDelivery = false } = {}) {
  const [seen, setSeen] = usePersistentState("usage_recorded", { input: 0, output: 0, cost: 0 });
  if (perDelivery) useAgentStart(async () => { setSeen({ input: 0, output: 0, cost: 0 }); });
  useAgentFinish(async ({ response }) => {
    const t = usageOf(response.usage, model);
    const d = { input: Math.max(0, t.input - seen.input), output: Math.max(0, t.output - seen.output), cost: Math.max(0, t.cost - (seen.cost || 0)) };
    console.log("[usage]", JSON.stringify({ model, total: t, delta: d, toolCalls: response.toolCalls.length }));
    if (!d.input && !d.output) return;
    try { await record(d, model); }
    catch (e) { console.error("[usage] recording failed", String(e && e.message || e)); throw e; }
    setSeen(t);
  });
}
