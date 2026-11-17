'use agent';
// The cloud research agent. One conversation (one Durable Object) per run; the conversation id is the run id.
// Pi runs the loop inside Flue: model turns, tool calls, retries, compaction and crash recovery. This file only
// says what the agent may do. Everything it reads is the starting editor's scoped view of the tree, and its only
// write is submit_results, which files suggestions for an editor to review.
import { env } from "cloudflare:workers";
import { useAgentFinish, useAgentStart, useInitialData, useModel, usePersistentState, useTool } from "@flue/runtime";
import * as v from "valibot";
import { scopedForRun } from "../../../worker/bundle.js";
import { settings, compactAt, modelSpec } from "../../../worker/agent/config.js";
import { SYSTEM, loadRun, markRunning, logRun, recordRunUsage, submitResults, endRun } from "../../../worker/agent/runs.js";
import { personView, searchPeople, relationship, checkSubmission } from "../../../worker/agent/tools.js";
import { useUsage } from "./usage.js";
import { useWebTools } from "../web.js";

const S = settings(env);
const FINISHED = ["succeeded", "failed", "cancelled"];
const str = (d) => v.pipe(v.string(), v.description(d));
const opt = (schema) => v.optional(schema);

const Source = v.looseObject({
  title: str("Record or collection title"),
  url: opt(str("The exact URL you retrieved. Never construct or guess one.")),
  note: opt(str("Where in the record, and what you actually saw (e.g. 'search-result snippet only', 'index entry, image not viewed')")),
});
const Submission = v.object({
  summary: str("Two to five sentences for the reviewing editor: what you looked for, what you found, how sure you are."),
  batch: opt(v.looseObject({
    findings: opt(v.array(v.looseObject({
      person: opt(v.string()),
      kind: v.picklist(["confirmed", "correction", "conflict", "data-error", "new-fact", "new-person"]),
      field: opt(v.string()), claim: opt(str("What the tree currently says, if relevant")),
      fact: opt(str("The fact id from get_person this is about (e3 for an event, n1 for a name), when it concerns one")),
      proposed_ops: opt(v.pipe(v.array(v.looseObject({ op: v.string() })), v.description("For a correction or new fact: the edit ops that would fix the tree, so an editor can apply them in one step"))),
      finding: str("What the record says, plainly"),
      confidence: v.picklist(["high", "medium", "low"]),
      sources: v.array(Source),
    }))),
    log: opt(v.array(v.looseObject({
      person: opt(v.string()), searched: str("Site/collection and the query or filters used"),
      result: v.picklist(["found", "nil", "inconclusive"]), note: opt(v.string()),
    }))),
    todo: opt(v.array(v.looseObject({
      person: opt(v.string()), task: v.string(), where: opt(v.string()), priority: v.picklist(["high", "medium", "low"]),
    }))),
    people_status: opt(v.record(v.string(), v.looseObject({ status: v.picklist(["partly-verified", "verified", "disputed"]), note: opt(v.string()) }))),
  })),
  edits: opt(v.looseObject({ reason: v.string(), sources: v.array(Source), ops: v.array(v.looseObject({ op: v.string() })) })),
});

export function Researcher({ id }) {
  // Every model call re-sends the whole conversation, so keep it small: older steps are summarised once it passes
  // ~48k tokens, and pages come back in short windows (web_fetch) that the agent widens only where it needs to.
  const M = S.agents.research;
  useModel(modelSpec(M.model), { thinkingLevel: M.effort, compaction: compactAt(M.model, 48000, 12000) });
  const data = useInitialData();
  const runId = (data && data.runId) || id;
  const [reminded, setReminded] = usePersistentState("reminded", false);

  /** The run's view of the tree, re-checked on every call: a cancelled run or a revoked grant stops the agent. */
  async function tree({ finishing = false } = {}) {
    const run = await loadRun(env, runId);
    if (!run) throw new Error("This run no longer exists.");
    // submit_results is durable: after a crash Flue re-runs it, and by then the run may already be "succeeded"
    if (FINISHED.includes(run.status) && !(finishing && run.status === "succeeded")) throw new Error(`This run is ${run.status}. Stop working.`);
    const sc = await scopedForRun(env, run);
    if (!sc) throw new Error(`${run.started_by} no longer has access to this tree. Stop working.`);
    return sc.bundle;
  }
  useAgentStart(async () => { await markRunning(env, runId); });
  useUsage((u, model) => recordRunUsage(env, runId, u, model), { model: M.model });

  useTool({
    name: "get_person",
    description: "Everything recorded about one person in the tree: names, events with their sources, notes, verification status, family (parents, spouses, children, siblings as ids and names), findings already made, searches already logged, open to-dos and automatic data-quality warnings. People the view keeps private come back as a name only and must not be researched.",
    input: v.object({ id: str("Person id, e.g. I12") }),
    async run({ data }) { return { output: personView(await tree(), data.id) }; },
  });
  useTool({
    name: "search_people",
    description: "Find people in the tree by name (any part of any recorded name, accents ignored). Returns up to 20 matches with id, name and life years.",
    input: v.object({ query: v.string() }),
    async run({ data }) { return { output: searchPeople(await tree(), data.query) }; },
  });
  useTool({
    name: "relationship_path",
    description: "How two people in the tree are related, as a chain of parent/child/spouse links with a plain-English summary.",
    input: v.object({ from: v.string(), to: v.string() }),
    async run({ data }) { return { output: relationship(await tree(), data.from, data.to) }; },
  });
  useWebTools({ id, runId, check: () => tree(), submitTool: "submit_results" });
  useTool({
    name: "submit_results",
    description: "Submit your work once, at the end. It is checked and, if valid, becomes suggestions an editor reviews; nothing changes in the tree until they approve. If it comes back with errors, fix them and call it again. Include every search you ran in batch.log, including the ones that found nothing.",
    input: Submission,
    durable: true,
    async run({ data, step }) {
      const r = await checkSubmission(env, await tree({ finishing: true }), data);
      if (!r.ok) throw new Error(`Not saved. Fix these and call submit_results again:\n- ${r.errors.join("\n- ")}`);
      const done = await step.do("file-suggestions", () => submitResults(env, runId, r.value));
      await step.do("log", () => logRun(env, runId, `submitted: suggestions ${done.proposals.map((p) => `#${p}`).join(", ")}`));
      // No `terminate`: ending the turn normally lets the finish hook record this run's token use.
      return { output: `Saved as suggestion${done.proposals.length > 1 ? "s" : ""} ${done.proposals.map((p) => `#${p}`).join(", ")}. An editor will review it. You're done: reply with one short sentence and stop.` };
    },
  });

  // The agent must end with a submission: one reminder, then the run is marked failed and its to-do released.
  useAgentFinish(async ({ response, append }) => {
    if (response.toolCalls.some((t) => t.tool === "submit_results" && !t.isError)) return;
    const run = await loadRun(env, runId);
    if (!run || FINISHED.includes(run.status)) return;
    if (!reminded) {
      setReminded(true);
      append({ kind: "signal", type: "reminder", body: "You haven't submitted anything. Call submit_results now. If every search came back empty, submit the log of nil results and any to-dos for the owner." });
      return;
    }
    await endRun(env, runId, "The agent finished without submitting results.");
  });

  return SYSTEM;
}
Researcher.agentName = "researcher";
Researcher.initialData = v.object({ runId: v.pipe(v.string(), v.regex(/^run-[\w-]+$/)) });
Researcher.durability = { maxAttempts: 3, timeoutMs: S.maxMinutes * 60_000 };
