'use agent';
// Narrative upkeep: short AI-written profiles for people who have died, and checks that stories still agree with
// the facts. Each job is its own small conversation, dispatched by src/content-jobs.js with the facts as the
// message; the agent answers through one tool, which stores the result (profiles) or files a suggestion (stories).
// Living relatives are written about like anyone else; as someone else's relative they appear by name only, with no dates.
import { env } from "cloudflare:workers";
import { useAgentFinish, useInitialData, useModel, usePersistentState, useTool } from "@flue/runtime";
import * as v from "valibot";
import { settings, recordUsage, modelSpec } from "../../../worker/agent/config.js";
import { PROFILE_SYSTEM, STORY_SYSTEM, saveProfile, saveStoryVerdict } from "../../../worker/agent/content.js";
import { useUsage } from "./usage.js";

const S = settings(env);
const spendOnly = (u) => env.DB.batch([recordUsage(env, u)]);

/** Insist on the one tool call, once; then give up quietly (the next weekly run tries again). */
function useMustCall(tool, nudge) {
  const [nudged, setNudged] = usePersistentState("nudged", false);
  useAgentFinish(async ({ response, append }) => {
    if (response.toolCalls.some((t) => t.tool === tool && !t.isError) || nudged) return;
    setNudged(true);
    append({ kind: "signal", type: "reminder", body: nudge });
  });
}

export function ProfileWriter() {
  const M = S.agents.profiles;
  useModel(modelSpec(M.model), { thinkingLevel: M.effort, compaction: false });
  const job = useInitialData();
  useUsage((u) => spendOnly(u), { model: M.model });
  useTool({
    name: "save_profile",
    description: "Save the finished profile. Call exactly once with the full text.",
    input: v.object({ text: v.pipe(v.string(), v.minLength(40), v.maxLength(4000)) }),
    durable: true,
    async run({ data, step }) {
      await step.do("save", () => saveProfile(env, job.person, { text: data.text, hash: job.hash, model: M.model }));
      return { output: "Saved. You're done." }; // no terminate: the finish hook records token use
    },
  });
  useMustCall("save_profile", "Call save_profile with the profile text.");
  return PROFILE_SYSTEM;
}
ProfileWriter.agentName = "profile-writer";
ProfileWriter.initialData = v.object({ person: v.string(), hash: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)) });
ProfileWriter.durability = { maxAttempts: 3, timeoutMs: 10 * 60_000 };

export function StoryReviewer() {
  const M = S.agents.profiles;
  useModel(modelSpec(M.model), { thinkingLevel: M.effort, compaction: false });
  const job = useInitialData();
  useUsage((u) => spendOnly(u), { model: M.model });
  useTool({
    name: "record_verdict",
    description: "Record whether the story still agrees with the facts. When it doesn't, include the full revised story; it goes to an editor as a suggestion.",
    input: v.object({
      up_to_date: v.boolean(),
      reason: v.pipe(v.string(), v.description("One or two sentences for the editor: what changed and why")),
      title: v.string(),
      body: v.pipe(v.string(), v.description("The full story: unchanged if up to date, otherwise the revised text")),
    }),
    durable: true,
    async run({ data, step }) {
      const r = await step.do("save", () => saveStoryVerdict(env, job.slug, { hash: job.hash, ...data }));
      return { output: r.proposal ? `Filed as suggestion #${r.proposal}. You're done.` : "Recorded. You're done." };
    },
  });
  useMustCall("record_verdict", "Call record_verdict with your decision.");
  return STORY_SYSTEM;
}
StoryReviewer.agentName = "story-reviewer";
StoryReviewer.initialData = v.object({ slug: v.string(), hash: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)) });
StoryReviewer.durability = { maxAttempts: 3, timeoutMs: 15 * 60_000 };
