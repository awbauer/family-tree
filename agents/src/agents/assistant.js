'use agent';
// The page assistant. One conversation (one Durable Object) per chat; the conversation id is the chat id. The site
// Worker sends the editor's messages with the page they're on attached. Everything the agent reads is the tree as
// that editor sees it, re-checked on every tool call, and its only write is propose_change: a pending change the
// editor applies or dismisses in the chat panel. It has no web access.
import { env } from "cloudflare:workers";
import { useAgentStart, useInitialData, useModel, usePersistentState, useTool } from "@flue/runtime";
import * as v from "valibot";
import { settings, compactAt } from "../../../worker/agent/config.js";
import { searchPeople, relationship } from "../../../worker/agent/tools.js";
import { CHAT_SYSTEM, loadChat, chatScope, chatPersonView, proposeChange, recordChatUsage, readPage } from "../../../worker/agent/chat.js";
import { useUsage } from "./usage.js";

const S = settings(env);
const str = (d) => v.pipe(v.string(), v.description(d));

export function Assistant({ id }) {
  // Keep the conversation small (it is re-sent on every model call): older turns are summarised past ~32k tokens.
  useModel(`cloudflare/${S.model}`, { thinkingLevel: S.chatEffort, compaction: compactAt(S, 32000, 8000) });
  const data = useInitialData();
  const chatId = (data && data.chatId) || id;
  const [, setSeen] = usePersistentState("usage_recorded", { input: 0, output: 0 });

  async function chat() {
    const c = await loadChat(env, chatId);
    if (!c) throw new Error("This chat no longer exists.");
    return c;
  }
  async function tree() {
    const sc = await chatScope(env, await chat());
    if (!sc) throw new Error("This editor no longer has editor access to the tree. Stop.");
    return sc.bundle;
  }

  // Each delivered message starts a new response, whose usage counts from zero: reset the high-water mark useUsage keeps.
  useAgentStart(async () => { setSeen({ input: 0, output: 0 }); });
  useUsage((u) => recordChatUsage(env, chatId, u));

  useTool({
    name: "get_person",
    description: "Everything recorded about one person: names and events with their fact ids (fid), sources, notes, photos, research status, the families they are a child or spouse in (with family ids, spouses and children), open findings and to-dos. Use the fids and family ids in propose_change.",
    input: v.object({ id: str("Person id, e.g. I12") }),
    async run({ data }) { return { output: chatPersonView(await tree(), data.id) }; },
  });
  useTool({
    name: "read_page",
    description: "The visible text of the page the editor is on (what they see: headings, facts, lists), or with find, only the lines that mention those words. Use it when they refer to something on the page that isn't a person's record.",
    input: v.object({ find: v.optional(str("Words to look for; omit for the whole page text")) }),
    async run({ data }) {
      await tree();
      const c = await chat();
      let snap = null; try { snap = c.page ? JSON.parse(c.page) : null; } catch {}
      return { output: readPage(snap, data.find) };
    },
  });
  useTool({
    name: "search_people",
    description: "Find people in the tree by name (any part of any recorded name, accents ignored). Up to 20 matches with id, name and life years.",
    input: v.object({ query: v.string() }),
    async run({ data }) { return { output: searchPeople(await tree(), data.query) }; },
  });
  useTool({
    name: "relationship_path",
    description: "How two people in the tree are related, as a chain of parent/child/spouse links with a plain-English summary.",
    input: v.object({ from: v.string(), to: v.string() }),
    async run({ data }) { return { output: relationship(await tree(), data.from, data.to) }; },
  });
  useTool({
    name: "person_history",
    description: "Recent changes to one person's record: when, by whom, what kind of change and why. Use it when asked what changed or who changed something.",
    input: v.object({ id: str("Person id") }),
    async run({ data }) {
      const b = await tree();
      if (!b.people[data.id] || b.people[data.id].private) return { output: { error: "Not a person this editor can see." } };
      const rows = (await env.DB.prepare("SELECT at, actor, op, reason, batch_id FROM changes WHERE entity_type = 'person' AND entity_id = ? ORDER BY id DESC LIMIT 15").bind(data.id).all()).results;
      return { output: rows.map((r) => ({ at: r.at.slice(0, 16), by: r.actor.split("@")[0], op: r.op, reason: r.reason || undefined, edit: r.batch_id || undefined })) };
    },
  });
  useTool({
    name: "propose_change",
    description: "Draft a change to the tree for the editor to confirm. It is checked and dry-run against the current tree; if it's valid, the editor sees exactly what will change, with Apply and Dismiss buttons. Nothing changes until they press Apply. A new proposal replaces one still waiting. If it comes back with errors, fix the ops and call it again.",
    input: v.object({
      summary: str("One line saying what the change does, e.g. \"Add Mary's death in 1931 and her burial\""),
      reason: str("Why: what the editor told you, or the record it comes from"),
      sources: v.optional(v.array(v.looseObject({ title: v.optional(v.string()), url: v.optional(v.string()), note: v.optional(v.string()) })), []),
      ops: v.pipe(v.array(v.looseObject({ op: v.string() })), v.minLength(1), v.description("Edit ops, applied in order as one change")),
    }),
    async run({ data }) {
      const r = await proposeChange(env, await chat(), data);
      if (!r.ok) throw new Error(`Not proposed. Fix these and call propose_change again:\n- ${r.errors.join("\n- ")}`);
      return { output: { change: r.id, records: r.records, note: "Shown to the editor with Apply and Dismiss buttons. It is not applied yet: ask them to check it and press Apply." } };
    },
  });

  return CHAT_SYSTEM;
}
Assistant.agentName = "assistant";
Assistant.initialData = v.object({ chatId: v.pipe(v.string(), v.regex(/^chat-[\w-]+$/)) });
Assistant.durability = { maxAttempts: 2, timeoutMs: 10 * 60_000 };
