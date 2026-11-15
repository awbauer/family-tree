// A custom hook (not an agent): report each response's token use once, as a delta, so the run and the daily AI
// budget in D1 match what the gateway billed. Flue's finish seam is at-least-once; the persisted high-water mark
// keeps a re-run from counting the same tokens twice.
import { useAgentFinish, usePersistentState } from "@flue/runtime";
import { env } from "cloudflare:workers";
import { settings, tokensOf } from "../../../worker/agent/config.js";

export function useUsage(record) {
  const [seen, setSeen] = usePersistentState("usage_recorded", { input: 0, output: 0 });
  useAgentFinish(async ({ response }) => {
    const t = tokensOf(response.usage);
    const d = { input: Math.max(0, t.input - seen.input), output: Math.max(0, t.output - seen.output) };
    console.log("[usage]", JSON.stringify({ total: t, delta: d, toolCalls: response.toolCalls.length }));
    if (!d.input && !d.output) return;
    try { await record(d, settings(env).model); }
    catch (e) { console.error("[usage] recording failed", String(e && e.message || e)); throw e; }
    setSeen(t);
  });
}
