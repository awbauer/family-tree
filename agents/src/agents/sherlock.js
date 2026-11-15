'use agent';
// Sherlock, the relatives finder (#44). One conversation (one Durable Object) per run; the conversation id is the run
// id. Starting from one person who has died, it searches records for parents, siblings, spouses and children who
// aren't in the tree yet. It reads the tree as the starting editor sees it (living people as a name only), uses the
// same web tools and research sites as the researcher, and its only write is submit_relatives, which files each
// candidate as a suggestion. Shared logic: worker/agent/relatives.js.
import { env } from "cloudflare:workers";
import { useAgentFinish, useAgentStart, useInitialData, useModel, usePersistentState, useTool } from "@flue/runtime";
import * as v from "valibot";
import { scopedFor } from "../../../worker/bundle.js";
import { settings, compactAt, modelSpec } from "../../../worker/agent/config.js";
import { loadRun, markRunning, logRun, recordRunUsage, endRun } from "../../../worker/agent/runs.js";
import { personView, searchPeople, relationship } from "../../../worker/agent/tools.js";
import { SHERLOCK_SYSTEM, RELATIONS, checkRelatives, submitRelatives } from "../../../worker/agent/relatives.js";
import { useUsage } from "./usage.js";
import { useWebTools } from "../web.js";

const S = settings(env);
const FINISHED = ["succeeded", "failed", "cancelled"];
const str = (d) => v.pipe(v.string(), v.description(d));
const opt = (schema) => v.optional(schema);

const Source = v.looseObject({
  title: str("Record or collection title"),
  url: opt(str("The exact URL you retrieved. Never construct or guess one.")),
  note: opt(str("What you actually saw, and whether it is an original record, an index or transcript, or a compiled tree")),
});
const When = v.looseObject({ date: opt(str("As the record gives it, e.g. 12 Mar 1881, abt 1850")), place: opt(v.string()) });
const Submission = v.object({
  summary: str("Two to five sentences for the reviewing editor: what you searched, what you found, how sure you are."),
  candidates: opt(v.array(v.looseObject({
    given: opt(v.string()), surname: opt(v.string()), sex: opt(v.picklist(["M", "F", "U"])),
    relation: v.picklist(RELATIONS), of: opt(str("Id of the person in the tree they are a relative of (default: the starting person)")),
    other_parent: opt(str("For a child: the id of the other parent, if they are in the tree")),
    born: opt(When), died: opt(When), married: opt(When),
    finding: str("What the records say about this relative, plainly"),
    confidence: v.picklist(["high", "medium", "low"]),
    sources: v.array(Source),
  }))),
  log: v.array(v.looseObject({ searched: str("Site/collection and the query or filters used"), result: v.picklist(["found", "nil", "inconclusive"]), note: opt(v.string()) })),
  todo: opt(v.array(v.looseObject({ task: v.string(), where: opt(v.string()), priority: v.picklist(["high", "medium", "low"]) }))),
});

export function Sherlock({ id }) {
  const M = S.agents.relatives;
  useModel(modelSpec(M.model), { thinkingLevel: M.effort, compaction: compactAt(M.model, 48000, 12000) });
  const data = useInitialData();
  const runId = (data && data.runId) || id;
  const [reminded, setReminded] = usePersistentState("reminded", false);

  /** The run and its view of the tree, re-checked on every call: a cancelled run or a revoked grant stops the agent. */
  async function ctx({ finishing = false } = {}) {
    const run = await loadRun(env, runId);
    if (!run) throw new Error("This run no longer exists.");
    if (FINISHED.includes(run.status) && !(finishing && run.status === "succeeded")) throw new Error(`This run is ${run.status}. Stop working.`);
    const sc = await scopedFor(env, run.started_by, run.tree_id);
    if (!sc) throw new Error(`${run.started_by} no longer has access to this tree. Stop working.`);
    return { run, b: sc.bundle };
  }

  useAgentStart(async () => { await markRunning(env, runId); });
  useUsage((u, model) => recordRunUsage(env, runId, u, model), { model: M.model });

  useTool({
    name: "get_person",
    description: "Everything recorded about one person in the tree: names, events with their sources, notes, family (parents, spouses, children, siblings as ids and names), findings, searches already logged, open to-dos. Living people come back as a name only and must not be researched.",
    input: v.object({ id: str("Person id, e.g. I12") }),
    async run({ data }) { return { output: personView((await ctx()).b, data.id) }; },
  });
  useTool({
    name: "search_people",
    description: "Find people in the tree by name (any part of any recorded name, accents ignored). Up to 20 matches with id, name and life years. Use it before proposing anyone: candidates already in the tree are dropped.",
    input: v.object({ query: v.string() }),
    async run({ data }) { return { output: searchPeople((await ctx()).b, data.query) }; },
  });
  useTool({
    name: "relationship_path",
    description: "How two people in the tree are related, as a chain of parent/child/spouse links with a plain-English summary.",
    input: v.object({ from: v.string(), to: v.string() }),
    async run({ data }) { return { output: relationship((await ctx()).b, data.from, data.to) }; },
  });
  useWebTools({ id, runId, check: () => ctx(), submitTool: "submit_relatives" });
  useTool({
    name: "submit_relatives",
    description: "Submit once, at the end: the relatives you found (candidates), every search you ran (log, nil results included) and follow-ups for the owner (todo). Each candidate becomes a suggestion an editor reviews; nothing changes in the tree until they accept it. Candidates already in the tree are dropped; anyone who could be living is reported only as a possible living relative. If it comes back with errors, fix them and call it again.",
    input: Submission,
    durable: true,
    async run({ data, step }) {
      const { run, b } = await ctx({ finishing: true });
      const r = await checkRelatives(env, b, run, data);
      if (!r.ok) throw new Error(`Not saved. Fix these and call submit_relatives again:\n- ${r.errors.join("\n- ")}`);
      const done = await step.do("file-suggestions", () => submitRelatives(env, runId, r.value));
      await step.do("log", () => logRun(env, runId, `submitted: ${r.value.candidates.length} candidate${r.value.candidates.length === 1 ? "" : "s"}, ${r.value.living.length} possibly living, ${r.value.already_in_tree.length} already in the tree; suggestions ${done.proposals.map((p) => `#${p}`).join(", ") || "none"}`));
      const notes = [];
      if (r.value.already_in_tree.length) notes.push(`Dropped as already in the tree: ${r.value.already_in_tree.map((x) => `${x.name} (= ${x.id})`).join(", ")}.`);
      if (r.value.living.length) notes.push(`${r.value.living.length} possible living relative${r.value.living.length === 1 ? "" : "s"} recorded without details.`);
      return { output: `Saved${done.proposals.length ? ` as suggestion${done.proposals.length > 1 ? "s" : ""} ${done.proposals.map((p) => `#${p}`).join(", ")}` : ""}. ${notes.join(" ")} You're done: reply with one short sentence and stop.` };
    },
  });

  // The agent must end with a submission: one reminder, then the run is marked failed.
  useAgentFinish(async ({ response, append }) => {
    if (response.toolCalls.some((t) => t.tool === "submit_relatives" && !t.isError)) return;
    const run = await loadRun(env, runId);
    if (!run || FINISHED.includes(run.status)) return;
    if (!reminded) {
      setReminded(true);
      append({ kind: "signal", type: "reminder", body: "You haven't submitted anything. Call submit_relatives now. If every search came back empty, submit the log of nil results and any to-dos for the owner." });
      return;
    }
    await endRun(env, runId, "The agent finished without submitting results.");
  });

  return SHERLOCK_SYSTEM;
}
Sherlock.agentName = "sherlock";
Sherlock.initialData = v.object({ runId: v.pipe(v.string(), v.regex(/^run-[\w-]+$/)) });
Sherlock.durability = { maxAttempts: 3, timeoutMs: S.maxMinutes * 60_000 };
