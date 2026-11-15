'use agent';
// The stories agent (issue #33). One conversation (one Durable Object) per run; the conversation id is the run id.
// It reviews and revises an existing story, or drafts a new one, from the tree as the starting editor sees it, with
// living people reduced to a name. Its only write is submit_story, which files a suggestion for an editor to review.
import { env } from "cloudflare:workers";
import { useAgentFinish, useAgentStart, useInitialData, useModel, usePersistentState, useTool } from "@flue/runtime";
import * as v from "valibot";
import { settings } from "../../../worker/agent/config.js";
import { loadRun, markRunning, recordRunUsage, endRun } from "../../../worker/agent/runs.js";
import { searchPeople, relationship } from "../../../worker/agent/tools.js";
import { STORY_WRITER_SYSTEM, runScope, storyView, listStories, siteContext, storyPerson, checkStory, submitStory } from "../../../worker/agent/stories.js";
import { useUsage } from "./usage.js";

const S = settings(env);
const FINISHED = ["succeeded", "failed", "cancelled"];
const str = (d) => v.pipe(v.string(), v.description(d));
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

export function StoryWriter({ id }) {
  useModel(`cloudflare/${S.model}`, { thinkingLevel: S.contentEffort, compaction: { keepRecentTokens: 20000 } });
  const runId = (useInitialData() || {}).runId || id;
  const [reminded, setReminded] = usePersistentState("reminded", false);

  async function ctx({ finishing = false } = {}) {
    const run = await loadRun(env, runId);
    if (!run) throw new Error("This run no longer exists.");
    if (FINISHED.includes(run.status) && !(finishing && run.status === "succeeded")) throw new Error(`This run is ${run.status}. Stop working.`);
    const sc = await runScope(env, run);
    if (!sc) throw new Error(`${run.started_by} is no longer an editor of this tree. Stop working.`);
    return { run, b: sc.bundle, o: parse(run.options, {}) };
  }

  useAgentStart(async () => { await markRunning(env, runId); });
  useUsage((u, model) => recordRunUsage(env, runId, u, model));

  useTool({
    name: "get_story",
    description: "One story in full: title, era, the people it is about, its sources and its text.",
    input: v.object({ slug: v.string() }),
    async run({ data }) { const { b } = await ctx(); return { output: storyView(b, data.slug) }; },
  });
  useTool({
    name: "list_stories",
    description: "The site's stories: slug, title, era and the people each is about. Useful to avoid repeating one.",
    input: v.object({}),
    async run() { const { b } = await ctx(); return { output: listStories(b) }; },
  });
  useTool({
    name: "get_person",
    description: "Everything recorded about one person: names, events with fact ids and their sources, notes, verification status, family (parents, spouses, children, siblings), findings. Living people come back as a name only.",
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
    description: "The site's historical context entries (year, title, which family branches they concern). The only background you may use beyond the records; cite one by its title.",
    input: v.object({}),
    async run() { const { b } = await ctx(); return { output: siteContext(b) }; },
  });
  useTool({
    name: "submit_story",
    description: "Submit once, at the end. Review: {summary, up_to_date} when the story needs nothing, or {summary, body, title?, changes:[{change, reason, facts}]}. Draft: {summary, title, era?, branch?, body, sources:[{title, note}], notes:[{paragraph, facts}]}. It becomes a suggestion an editor reviews. If it comes back with errors, fix them and call it again.",
    input: v.looseObject({
      summary: str("Two or three sentences for the reviewing editor"),
      up_to_date: v.optional(v.boolean()),
      title: v.optional(v.string()), era: v.optional(v.string()), branch: v.optional(v.string()),
      body: v.optional(str("The full story text")),
      sources: v.optional(v.array(v.looseObject({ title: v.string(), note: v.optional(v.string()) }))),
      changes: v.optional(v.array(v.looseObject({ change: v.string(), reason: v.string(), facts: v.optional(v.array(v.string())) }))),
      notes: v.optional(v.array(v.looseObject({ paragraph: v.string(), facts: v.optional(v.array(v.string())) }))),
    }),
    durable: true,
    async run({ data, step }) {
      const { run, b, o } = await ctx({ finishing: true });
      const r = checkStory(b, o, data);
      if (!r.ok) throw new Error(`Not saved. Fix these and call submit_story again:\n- ${r.errors.join("\n- ")}`);
      const done = await step.do("file", () => submitStory(env, run, r.value));
      return { output: done.proposals.length ? `Saved as suggestion #${done.proposals[0]}. An editor will review it. Reply with one short sentence and stop.` : "Recorded: the story is up to date. Reply with one short sentence and stop." };
    },
  });

  useAgentFinish(async ({ response, append }) => {
    if (response.toolCalls.some((t) => t.tool === "submit_story" && !t.isError)) return;
    const run = await loadRun(env, runId);
    if (!run || FINISHED.includes(run.status)) return;
    if (!reminded) {
      setReminded(true);
      append({ kind: "signal", type: "reminder", body: "You haven't submitted anything. Call submit_story now." });
      return;
    }
    await endRun(env, runId, "The agent finished without submitting a story.");
  });

  return STORY_WRITER_SYSTEM;
}
StoryWriter.agentName = "story-writer";
StoryWriter.initialData = v.object({ runId: v.pipe(v.string(), v.regex(/^run-[\w-]+$/)) });
StoryWriter.durability = { maxAttempts: 3, timeoutMs: 20 * 60_000 };
