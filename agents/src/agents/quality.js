'use agent';
// The data quality review (issue #31). One conversation (one Durable Object) per run; the conversation id is the run
// id. It reads the tree as the editor who started the run sees it, with no web access, and decides each planned item
// with record_decision: applied at once (to-do and finding bookkeeping, logged as agent:data-quality on the editor's
// behalf) or, in a dry run, recorded as a report. Fixes to facts only ever become suggestions.
import { env } from "cloudflare:workers";
import { useAgentFinish, useAgentStart, useInitialData, useModel, usePersistentState, useTool } from "@flue/runtime";
import * as v from "valibot";
import { settings, compactAt, modelSpec } from "../../../worker/agent/config.js";
import { usedUsd } from "../meter.js";
import { loadRun, markRunning, logRun, recordRunUsage, endRun } from "../../../worker/agent/runs.js";
import { searchPeople, relationship } from "../../../worker/agent/tools.js";
import { chatPersonView } from "../../../worker/agent/chat.js";
import { QUALITY_SYSTEM, runScope, itemView, checkDecision, recordDecision, reportOf, summarize } from "../../../worker/agent/quality.js";
import { useUsage } from "./usage.js";

const S = settings(env);
const FINISHED = ["succeeded", "failed", "cancelled"];
const str = (d) => v.pipe(v.string(), v.description(d));
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

export function QualityReviewer({ id }) {
  // Items are decided one at a time; earlier ones needn't stay in full. Summarise past ~40k tokens.
  const M = S.agents.quality;
  useModel(modelSpec(M.model), { thinkingLevel: M.effort, compaction: compactAt(M.model, 40000, 10000) });
  const runId = (useInitialData() || {}).runId || id;
  const [reminded, setReminded] = usePersistentState("reminded", false);

  /** The run and the editor's view of the tree, re-checked on every call. */
  async function ctx({ finishing = false } = {}) {
    const run = await loadRun(env, runId);
    if (!run) throw new Error("This run no longer exists.");
    if (FINISHED.includes(run.status) && !(finishing && run.status === "succeeded")) throw new Error(`This run is ${run.status}. Stop working.`);
    if (usedUsd(id) >= S.runUsd && !finishing) throw new Error("This run's budget is used up. Call finish_review now; the remaining items stay open for another run.");
    const sc = await runScope(env, run);
    if (!sc) throw new Error(`${run.started_by} is no longer an editor of this tree. Stop working.`);
    return { run, sc, b: sc.bundle };
  }

  useAgentStart(async () => { await markRunning(env, runId); });
  useUsage((u, model) => recordRunUsage(env, runId, u, model), M.model);

  useTool({
    name: "get_item",
    description: "One item to review in full: a to-do with its history and comments, or a finding with its claim, sources and the fact it concerns.",
    input: v.object({ item: str("todo:<id> or finding:<id>") }),
    async run({ data }) { const { b } = await ctx(); return { output: await itemView(env, b, data.item) }; },
  });
  useTool({
    name: "get_person",
    description: "Everything the tree records about one person: names and events with fact ids (fid), sources, notes, the families they belong to (with ids), open findings and to-dos.",
    input: v.object({ id: str("Person id, e.g. I12") }),
    async run({ data }) { const { b } = await ctx(); return { output: chatPersonView(b, data.id) }; },
  });
  useTool({
    name: "search_people",
    description: "Find people by name (any part of any recorded name, accents ignored): duplicates, namesakes, relatives. Up to 20 matches.",
    input: v.object({ query: v.string() }),
    async run({ data }) { const { b } = await ctx(); return { output: searchPeople(b, data.query) }; },
  });
  useTool({
    name: "relationship_path",
    description: "How two people in the tree are related, as a chain of parent/child/spouse links.",
    input: v.object({ from: v.string(), to: v.string() }),
    async run({ data }) { const { b } = await ctx(); return { output: relationship(b, data.from, data.to) }; },
  });
  useTool({
    name: "record_decision",
    description: "Your decision on one item, once per item. Outside a dry run it is applied at once (if the item hasn't changed meanwhile); in a dry run it is recorded for an editor to apply later. A fix is always filed as a suggestion, never applied.",
    input: v.object({
      item: str("todo:<id> or finding:<id>"),
      verdict: v.picklist(["still_valid", "resolved", "obsolete", "duplicate", "needs_human"]),
      note: str("What you checked and why you decided this, in one to three sentences"),
      evidence: v.optional(v.array(v.string()), []),
      duplicate_of: v.optional(str("For duplicate: the item kept, e.g. todo:12")),
      priority: v.optional(v.picklist(["high", "medium", "low"])),
      fix: v.optional(v.looseObject({ reason: v.string(), ops: v.array(v.looseObject({ op: v.string() })) })),
      new_todos: v.optional(v.array(v.looseObject({ task: v.string(), person: v.optional(v.string()), where: v.optional(v.string()), priority: v.optional(v.picklist(["high", "medium", "low"])) }))),
    }),
    durable: true,
    async run({ data, step }) {
      const { run, sc } = await ctx();
      const r = await checkDecision(env, sc, run, data);
      if (!r.ok) throw new Error(`Not recorded. Fix these and call record_decision again:\n- ${r.errors.join("\n- ")}`);
      const out = await step.do(`decide-${r.decision.item}`, () => recordDecision(env, run, r.decision));
      await step.do(`log-${r.decision.item}`, () => logRun(env, runId, `${out.item}: ${out.verdict} → ${out.status} (${out.detail})`));
      const done = reportOf(await loadRun(env, runId)).map((d) => d.item);
      const left = (parse(run.options, {}).items || []).filter((x) => !done.includes(x.ref)).length;
      return { output: { item: out.item, status: out.status, detail: out.detail, items_left: left } };
    },
  });
  useTool({
    name: "finish_review",
    description: "Call once, after the last item, with a short summary for the editor.",
    input: v.object({ summary: str("Two to four sentences: what you reviewed and what changed (or would change)") }),
    durable: true,
    async run({ data, step }) {
      const { run } = await ctx({ finishing: true });
      const report = reportOf(run);
      const missing = (parse(run.options, {}).items || []).filter((x) => !report.some((d) => d.item === x.ref)).map((x) => x.ref);
      // past the run's token cap it may stop early; the undecided items simply stay open
      if (missing.length && run.status !== "succeeded" && usedUsd(id) < S.runUsd) throw new Error(`Decide these first with record_decision: ${missing.join(", ")}`);
      await step.do("finish", () => env.DB.prepare("UPDATE agent_runs SET status = 'succeeded', result = ?, proposal_ids = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ? AND status IN ('queued', 'running', 'succeeded')")
        .bind(JSON.stringify({ summary: data.summary, counts: summarize(report) }), JSON.stringify(report.map((d) => d.proposal).filter(Boolean)), new Date().toISOString(), runId).run());
      return { output: "Saved. You're done: reply with one short sentence and stop." };
    },
  });

  useAgentFinish(async ({ response, append }) => {
    if (response.toolCalls.some((t) => t.tool === "finish_review" && !t.isError)) return;
    const run = await loadRun(env, runId);
    if (!run || FINISHED.includes(run.status)) return;
    if (!reminded) {
      setReminded(true);
      append({ kind: "signal", type: "reminder", body: "You haven't finished. Record a decision for every remaining item with record_decision, then call finish_review." });
      return;
    }
    await endRun(env, runId, `The review stopped after ${reportOf(run).length} item(s) without finishing.`);
  });

  return QUALITY_SYSTEM;
}
QualityReviewer.agentName = "quality-reviewer";
QualityReviewer.initialData = v.object({ runId: v.pipe(v.string(), v.regex(/^run-[\w-]+$/)) });
QualityReviewer.durability = { maxAttempts: 3, timeoutMs: S.maxMinutes * 60_000 };
