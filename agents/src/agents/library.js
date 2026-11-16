'use agent';
// The stories librarian (issue #36). One conversation (one Durable Object) per run; the conversation id is the run id.
// It audits every published story against the tree as the starting editor sees it, files each fix as a story
// revision suggestion, ranks candidate subjects for new stories, and commissions up to N story-writer runs (each its
// own StoryWriter conversation, linked to this run). Nothing published changes until an editor approves a suggestion.
import { env } from "cloudflare:workers";
import { dispatch, useAgentFinish, useAgentStart, useInitialData, useModel, usePersistentState, useTool } from "@flue/runtime";
import * as v from "valibot";
import { settings, compactAt, modelSpec } from "../../../worker/agent/config.js";
import { usedUsd } from "../meter.js";
import { loadRun, markRunning, recordRunUsage, endRun } from "../../../worker/agent/runs.js";
import { searchPeople, relationship } from "../../../worker/agent/tools.js";
import { storyPerson, siteContext } from "../../../worker/agent/stories.js";
import { LIBRARY_SYSTEM, runScope, libraryStoryView, rankCandidates, checkStoryCheck, recordStoryCheck, checkCommission, commissionStory, finishLibrary, reportOf } from "../../../worker/agent/library.js";
import { StoryWriter } from "./stories.js";
import { useUsage } from "./usage.js";

const S = settings(env);
const FINISHED = ["succeeded", "failed", "cancelled"];
const str = (d) => v.pipe(v.string(), v.description(d));
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

export function StoryLibrarian({ id }) {
  // Stories are audited one at a time; earlier ones needn't stay in full. Summarise past ~40k tokens.
  const M = S.agents.library;
  useModel(modelSpec(M.model), { thinkingLevel: M.effort, compaction: compactAt(M.model, 40000, 10000) });
  const runId = (useInitialData() || {}).runId || id;
  const [reminded, setReminded] = usePersistentState("library_reminded", false);

  /** The run and the editor's view of the tree, re-checked on every call. */
  async function ctx({ finishing = false } = {}) {
    const run = await loadRun(env, runId);
    if (!run) throw new Error("This run no longer exists.");
    if (FINISHED.includes(run.status) && !(finishing && run.status === "succeeded")) throw new Error(`This run is ${run.status}. Stop working.`);
    if (usedUsd(id) >= S.runUsd && !finishing) throw new Error("This run's budget is used up. Call finish_library now; the remaining stories wait for another run.");
    const sc = await runScope(env, run);
    if (!sc) throw new Error(`${run.started_by} is no longer an editor of this tree. Stop working.`);
    return { run, b: sc.bundle };
  }

  useAgentStart(async () => { await markRunning(env, runId); });
  useUsage((u, model) => recordRunUsage(env, runId, u, model), { model: M.model });

  useTool({
    name: "get_story",
    description: "One story in full (title, era, people, sources, text) and the problems the site's checks find in it now: links to people who are gone or were merged, and dated claims the records contradict or don't record.",
    input: v.object({ slug: v.string() }),
    async run({ data }) { const { b } = await ctx(); return { output: libraryStoryView(b, data.slug) }; },
  });
  useTool({
    name: "get_person",
    description: "Everything recorded about one person: names, events with fact ids and their sources, notes, verification status, family, findings. People the view keeps private come back as a name only.",
    input: v.object({ id: str("Person id, e.g. I12") }),
    async run({ data }) { const { b } = await ctx(); return { output: storyPerson(b, data.id) }; },
  });
  useTool({
    name: "search_people",
    description: "Find people in the tree by name. Up to 20 matches with id, name and life years.",
    input: v.object({ query: v.string() }),
    async run({ data }) { const { b } = await ctx(); return { output: searchPeople(b, data.query) }; },
  });
  useTool({
    name: "relationship_path",
    description: "How two people in the tree are related, with a plain-English summary.",
    input: v.object({ from: v.string(), to: v.string() }),
    async run({ data }) { const { b } = await ctx(); return { output: relationship(b, data.from, data.to) }; },
  });
  useTool({
    name: "site_context",
    description: "The site's historical context entries (year, title, branches). The only background a revision may use beyond the records.",
    input: v.object({}),
    async run() { const { b } = await ctx(); return { output: siteContext(b) }; },
  });
  useTool({
    name: "get_candidates",
    description: "Candidate subjects for new stories, best first: people who have died with sourced records, and events several people share. Each has a score, what material exists, and which stories already cover it.",
    input: v.object({ limit: v.optional(v.number(), 20) }),
    async run({ data }) { const { b } = await ctx(); return { output: rankCandidates(b, { limit: Math.min(40, Math.max(1, data.limit | 0 || 20)) }) }; },
  });
  useTool({
    name: "check_story",
    description: "Your verdict on one story, once per story. revised needs the full revised body and the list of changes; it is checked like any story revision and filed as a suggestion for an editor. If it comes back with errors, fix them and call it again.",
    input: v.object({
      slug: v.string(),
      verdict: v.picklist(["up_to_date", "revised", "needs_editor"]),
      note: str("What you checked and found, in one to three sentences, for the editor"),
      title: v.optional(v.string()),
      body: v.optional(str("revised: the full revised story text")),
      changes: v.optional(v.array(v.looseObject({ change: v.string(), reason: v.string(), facts: v.optional(v.array(v.string())) }))),
    }),
    durable: true,
    async run({ data, step }) {
      const { run, b } = await ctx();
      const r = checkStoryCheck(b, run, data);
      if (!r.ok) throw new Error(`Not recorded. Fix these and call check_story again:\n- ${r.errors.join("\n- ")}`);
      const out = await step.do(`check-${r.value.slug}`, () => recordStoryCheck(env, run, r.value));
      const left = (parse(run.options, {}).stories || []).filter((s) => s.slug !== out.slug && !reportOf(run).checked.some((c) => c.slug === s.slug)).length;
      return { output: { slug: out.slug, verdict: out.verdict, suggestion: out.proposal, stories_left: left } };
    },
  });
  useTool({
    name: "commission_story",
    description: "Start a story-writer run for a new story about one candidate subject (one or more people who have died), with a brief. Counts against today's run budget. At most the number the first message allows.",
    input: v.object({
      people: v.array(str("Person id")),
      brief: str("For the story writer: who it is about, the angle, and the facts and sources to build on (person and fact ids)"),
      length: v.optional(v.picklist(["short", "medium", "long"])),
      candidate: v.optional(str("The candidate's key from the list, e.g. person:I12 or group:…")),
    }),
    durable: true,
    async run({ data, step }) {
      const { run, b } = await ctx();
      const r = checkCommission(b, run, data);
      if (!r.ok) throw new Error(`Not started. ${r.errors.join("; ")}`);
      const c = await step.do(`commission-${r.value.key}`, () => commissionStory(env, run, b, r.value));
      if (c.error) throw new Error(c.error);
      try {
        // the idempotency key makes a replayed dispatch converge on the first delivery
        await step.do(`dispatch-${c.id}`, async () => { await dispatch(StoryWriter, { id: c.id, initialData: { runId: c.id }, message: { kind: "user", body: c.message }, idempotencyKey: `library-${c.id}` }); return true; });
      } catch (e) {
        await endRun(env, c.id, `the story writer didn't accept the run: ${e.message}`);
        throw new Error(`The story run couldn't start: ${e.message}`);
      }
      return { output: { started: c.id, people: r.value.people } };
    },
  });
  useTool({
    name: "finish_library",
    description: "Call once, after every story is checked and the new stories are commissioned, with a short summary for the editor.",
    input: v.object({ summary: str("Two to four sentences: what you checked, what you fixed or flagged, and which stories you commissioned") }),
    durable: true,
    async run({ data, step }) {
      const { run } = await ctx({ finishing: true });
      const done = reportOf(run).checked.map((c) => c.slug);
      const missing = (parse(run.options, {}).stories || []).map((s) => s.slug).filter((s) => !done.includes(s));
      // past the run's budget it may stop early; the unchecked stories wait for another run
      if (missing.length && run.status !== "succeeded" && usedUsd(id) < S.runUsd) throw new Error(`Check these first with check_story: ${missing.join(", ")}`);
      await step.do("finish", () => finishLibrary(env, run, data.summary));
      return { output: "Saved. You're done: reply with one short sentence and stop." };
    },
  });

  useAgentFinish(async ({ response, append }) => {
    if (response.toolCalls.some((t) => t.tool === "finish_library" && !t.isError)) return;
    const run = await loadRun(env, runId);
    if (!run || FINISHED.includes(run.status)) return;
    if (!reminded) {
      setReminded(true);
      append({ kind: "signal", type: "reminder", body: "You haven't finished. Call check_story for every remaining story, commission new stories if any are allowed, then call finish_library." });
      return;
    }
    await endRun(env, runId, `The library review stopped after ${reportOf(run).checked.length} stor${reportOf(run).checked.length === 1 ? "y" : "ies"} without finishing.`);
  });

  return LIBRARY_SYSTEM;
}
StoryLibrarian.agentName = "story-librarian";
StoryLibrarian.initialData = v.object({ runId: v.pipe(v.string(), v.regex(/^run-[\w-]+$/)) });
StoryLibrarian.durability = { maxAttempts: 3, timeoutMs: S.maxMinutes * 60_000 };
