'use agent';
// The cloud research agent. One conversation (one Durable Object) per run; the conversation id is the run id.
// Pi runs the loop inside Flue: model turns, tool calls, retries, compaction and crash recovery. This file only
// says what the agent may do. Everything it reads is the starting editor's scoped view of the tree, and its only
// write is submit_results, which files suggestions for an editor to review.
import { env } from "cloudflare:workers";
import { useAgentFinish, useAgentStart, useInitialData, useModel, usePersistentState, useTool } from "@flue/runtime";
import * as v from "valibot";
import { createAIWebSearch, renderWebSearchResults } from "agents/websearch";
import { fetchWeb, windowWebFetchPage, renderWebFetchPage } from "agents/webfetch";
import { scopedFor } from "../../../worker/bundle.js";
import { settings, checkDaily, compactAt, modelSpec, BudgetError } from "../../../worker/agent/config.js";
import { usedUsd } from "../meter.js";
import { pageView } from "../../../worker/agent/pages.js";
import { SYSTEM, loadRun, markRunning, logRun, recordRunUsage, recordUsed, submitResults, endRun } from "../../../worker/agent/runs.js";
import { personView, searchPeople, relationship, checkSubmission } from "../../../worker/agent/tools.js";
import { useUsage } from "./usage.js";

const S = settings(env);
// General search engines forbid scraping their result pages (and mostly block it anyway). Search goes through the
// Web Search API; without it, the agent uses record sites' own search pages.
const BLOCKED_HOSTS = ["google.com", "*.google.com", "*.google.co.uk", "bing.com", "*.bing.com", "duckduckgo.com", "*.duckduckgo.com", "search.yahoo.com", "yandex.com", "*.yandex.com", "*.baidu.com"];
const FINISHED = ["succeeded", "failed", "cancelled"];
const PAGE_CHARS = 6000; // one window of a fetched page (the library default is 20,000)
// Pages this conversation fetched, so reading on or searching within one doesn't download it again (per isolate).
const pageCache = new Map();
const remember = (url, page) => { pageCache.set(url, page); if (pageCache.size > 12) pageCache.delete(pageCache.keys().next().value); };
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
    const sc = await scopedFor(env, run.started_by, run.tree_id);
    if (!sc) throw new Error(`${run.started_by} no longer has access to this tree. Stop working.`);
    return sc.bundle;
  }
  /** Count a web call against the run's budget (atomically, in D1); null when the budget is used up. */
  async function spend(kind, max) {
    if (usedUsd(id) >= S.runUsd) return null; // this run's own spending cap
    try { await checkDaily(env, S); } catch (e) { if (e instanceof BudgetError) return null; throw e; }
    const r = await env.DB.prepare(`UPDATE agent_runs SET ${kind} = ${kind} + 1 WHERE id = ? AND ${kind} < ? RETURNING ${kind}`).bind(runId, max).first();
    return r ? r[kind] : null;
  }

  useAgentStart(async () => { await markRunning(env, runId); });
  useUsage((u, model) => recordRunUsage(env, runId, u, model), { model: M.model });

  useTool({
    name: "get_person",
    description: "Everything recorded about one person in the tree: names, events with their sources, notes, verification status, family (parents, spouses, children, siblings as ids and names), findings already made, searches already logged, open to-dos and automatic data-quality warnings. Living people come back as a name only and must not be researched.",
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
  useTool({
    name: "web_search",
    description: `Search the public web (Cloudflare Web Search API). Returns numbered results with title, URL and a short description; read promising ones with web_fetch. Budget: ${S.maxSearches} searches per run.`,
    input: v.object({ query: v.pipe(v.string(), v.minLength(1), v.maxLength(1000)), limit: opt(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10))) }),
    timeoutMs: 45_000,
    async run({ data, signal }) {
      await tree();
      const n = await spend("searches", S.maxSearches);
      if (n == null) return "The search budget for this run (or today's AI budget) is used up. Submit what you have with submit_results now.";
      try {
        const res = await createAIWebSearch({ binding: env.AI, gateway: S.gateway, provider: S.searchProvider, byokAlias: S.searchByokAlias }).search({ query: data.query, limit: data.limit || 6 }, { signal });
        await logRun(env, runId, `web_search: ${data.query}`);
        await recordUsed(env, runId, { kind: "search", query: data.query, provider: S.searchProvider });
        return renderWebSearchResults(res);
      } catch (e) {
        // Search bills to AI Gateway credits (or a stored provider key). Without them, keep researching by reading
        // record sites' own search pages directly.
        if (!/payment|credit|402|byok/i.test(String(e && (e.code || e.message)))) throw e;
        await logRun(env, runId, "web_search unavailable (no AI Gateway credits); using sites' own search pages");
        return "Web search is not available for this run (no AI Gateway credits). Don't call web_search again, and don't fetch general search engines (Google, Bing, DuckDuckGo): they're blocked. Instead, use web_fetch on the search pages of free record sites with the query in the URL, for example https://www.findagrave.com/memorial/search?firstname=…&lastname=…&deathyear=…, https://www.freebmd.org.uk/, https://www.familysearch.org/search/ (may need a login), https://billiongraves.com/search/results?given_names=…&family_names=…, and national archive catalogues. Cite only pages you actually read.";
      }
    },
  });
  useTool({
    name: "web_fetch",
    description: `Read a web page, PDF or document as Markdown, a piece at a time. The first call returns the page's outline (its headings, with offsets) and the first ${PAGE_CHARS.toLocaleString("en")} characters. To read on, pass offset; to see only the passages that mention something (a name, a year, a place), pass find, e.g. find: "Smith 1923". Prefer find on long pages. Reading more of a page you already fetched doesn't count against the budget. Only cite pages you have read this way. Budget: ${S.maxFetches} pages per run.`,
    input: v.object({
      url: v.pipe(v.string(), v.url()),
      offset: opt(v.pipe(v.number(), v.integer(), v.minValue(0))),
      find: opt(str("Words to look for on the page; returns only the passages that mention them, with their offsets")),
    }),
    timeoutMs: 60_000,
    async run({ data, signal }) {
      await tree();
      let page = pageCache.get(data.url);
      if (!page) {
        const n = await spend("fetches", S.maxFetches);
        if (n == null) return "The page budget for this run (or its budget, or today's AI budget) is used up. Submit what you have with submit_results now.";
        page = await fetchWeb({ url: data.url }, { binding: env.AI, timeoutMs: 45_000, maxBytes: 4_000_000, blockedHosts: BLOCKED_HOSTS, signal });
        remember(data.url, page);
        await logRun(env, runId, `web_fetch: ${data.url}`);
        await recordUsed(env, runId, { kind: "page", url: page.finalUrl || data.url, title: page.title, status: page.status, contentType: page.contentType });
      } else if (usedUsd(id) >= S.runUsd) return "This run's budget is used up. Submit what you have with submit_results now.";
      return pageView(page, { offset: data.offset, find: data.find, chars: PAGE_CHARS, render: (w) => renderWebFetchPage(windowWebFetchPage(page, w)) });
    },
  });
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
