// The web tools every research agent shares (the researcher, Sherlock): web_search, web_fetch and research_sites.
// A custom hook, not an agent: call it during an agent's render. web_fetch reads pages in short windows
// (worker/agent/pages.js) and, when a page is on a listed research site with a saved credential, signs in for the
// agent: the credential is decrypted and added here, server-side, over https only, and only for that site's own hosts
// (a redirect elsewhere is followed without it). The model never sees the value.
import { env } from "cloudflare:workers";
import { useTool } from "@flue/runtime";
import * as v from "valibot";
import { createAIWebSearch, renderWebSearchResults } from "agents/websearch";
import { fetchWeb, windowWebFetchPage, renderWebFetchPage } from "agents/webfetch";
import { settings, checkDaily, BudgetError } from "../../worker/agent/config.js";
import { pageView } from "../../worker/agent/pages.js";
import { logRun, recordUsed } from "../../worker/agent/runs.js";
import { listSites, sitesDetail, loadCredentials, credentialedFetch, scrubSecrets } from "../../worker/agent/sites.js";
import { usedUsd } from "./meter.js";

const S = settings(env);
// General search engines forbid scraping their result pages (and mostly block it anyway). Search goes through the
// Web Search API; without it, the agent uses record sites' own search pages.
export const BLOCKED_HOSTS = ["google.com", "*.google.com", "*.google.co.uk", "bing.com", "*.bing.com", "duckduckgo.com", "*.duckduckgo.com", "search.yahoo.com", "yandex.com", "*.yandex.com", "*.baidu.com"];
export const PAGE_CHARS = 6000; // one window of a fetched page (the library default is 20,000)
// Pages each conversation fetched, so reading on or searching within one doesn't download it again (per isolate).
const pageCache = new Map();
const remember = (key, page) => { pageCache.set(key, page); if (pageCache.size > 24) pageCache.delete(pageCache.keys().next().value); };
const str = (d) => v.pipe(v.string(), v.description(d));
const opt = (schema) => v.optional(schema);

/** Count a web call against the run's budget (atomically, in D1); null when the budget is used up. */
async function spend(id, runId, kind, max) {
  if (usedUsd(id) >= S.runUsd) return null; // this run's own spending cap
  try { await checkDaily(env, S); } catch (e) { if (e instanceof BudgetError) return null; throw e; }
  const r = await env.DB.prepare(`UPDATE agent_runs SET ${kind} = ${kind} + 1 WHERE id = ? AND ${kind} < ? RETURNING ${kind}`).bind(runId, max).first();
  return r ? r[kind] : null;
}

/**
 * Register web_search, web_fetch and research_sites. `check()` re-validates the run before each call (throws when the
 * run is over or the starter lost access); `submitTool` names the agent's submit tool for budget messages.
 */
export function useWebTools({ id, runId, check, submitTool }) {
  const submitNow = `Submit what you have with ${submitTool} now.`;
  useTool({
    name: "research_sites",
    description: "The owner's list of research sites, in full: coverage, record types, access (open, free-account, subscription, institution), source quality, search URL templates, notes on how to search each, and whether a credential is available. Filter by record_type (census, vital, church, military, immigration, newspapers, graves, land, probate, compiled-trees, directory), access, or a word.",
    input: v.object({ record_type: opt(v.string()), access: opt(v.string()), query: opt(str("A word to look for in the name, coverage or notes, e.g. a country")) }),
    async run({ data }) { await check(); return { output: sitesDetail(await listSites(env, { enabledOnly: true }), data) }; },
  });
  useTool({
    name: "web_search",
    description: `Search the public web (Cloudflare Web Search API). Returns numbered results with title, URL and a short description; read promising ones with web_fetch. Budget: ${S.maxSearches} searches per run.`,
    input: v.object({ query: v.pipe(v.string(), v.minLength(1), v.maxLength(1000)), limit: opt(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10))) }),
    timeoutMs: 45_000,
    async run({ data, signal }) {
      await check();
      const n = await spend(id, runId, "searches", S.maxSearches);
      if (n == null) return `The search budget for this run (or today's AI budget) is used up. ${submitNow}`;
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
        return "Web search is not available for this run (no AI Gateway credits). Don't call web_search again, and don't fetch general search engines (Google, Bing, DuckDuckGo): they're blocked. Instead, use web_fetch on the search pages of the research sites in your first message: fill in a site's search_url template where it has one (research_sites lists them all), or open its search page. Cite only pages you actually read.";
      }
    },
  });
  useTool({
    name: "web_fetch",
    description: `Read a web page, PDF or document as Markdown, a piece at a time. The first call returns the page's outline (its headings, with offsets) and the first ${PAGE_CHARS.toLocaleString("en")} characters. To read on, pass offset; to see only the passages that mention something (a name, a year, a place), pass find, e.g. find: "Smith 1923". Prefer find on long pages. Reading more of a page you already fetched doesn't count against the budget. On a listed research site with a saved credential, it signs in for you. Only cite pages you have read this way. Budget: ${S.maxFetches} pages per run.`,
    input: v.object({
      url: v.pipe(v.string(), v.url()),
      offset: opt(v.pipe(v.number(), v.integer(), v.minValue(0))),
      find: opt(str("Words to look for on the page; returns only the passages that mention them, with their offsets")),
    }),
    timeoutMs: 60_000,
    async run({ data, signal }) {
      await check();
      const key = `${id} ${data.url}`;
      let page = pageCache.get(key);
      if (!page) {
        const n = await spend(id, runId, "fetches", S.maxFetches);
        if (n == null) return `The page budget for this run (or its budget, or today's AI budget) is used up. ${submitNow}`;
        const creds = await loadCredentials(env, { onError: (r) => console.error("[sites] a credential didn't decrypt", JSON.stringify({ site: r.id })) });
        let used = null;
        const doFetch = credentialedFetch({ requested: data.url, creds, onUse: (s) => { used = s; } });
        page = await fetchWeb({ url: data.url }, { binding: env.AI, fetch: doFetch, timeoutMs: 45_000, maxBytes: 4_000_000, blockedHosts: BLOCKED_HOSTS, signal });
        if (used) page = { ...page, signedInTo: used.name };
        if (used) { // a site can echo a key back (a redirect URL, the page itself): keep it from the model and the logs
          page = JSON.parse(scrubSecrets(JSON.stringify(page), used));
          page.totalChars = page.content.length;
        }
        remember(key, page);
        await logRun(env, runId, `web_fetch${used ? ` (signed in to ${used.name})` : ""}: ${data.url}`);
        await recordUsed(env, runId, { kind: "page", url: page.finalUrl || data.url, title: page.title, status: page.status, contentType: page.contentType, ...(used ? { credential: true, site: used.id } : {}) });
      } else if (usedUsd(id) >= S.runUsd) return `This run's budget is used up. ${submitNow}`;
      const view = pageView(page, { offset: data.offset, find: data.find, chars: PAGE_CHARS, render: (w) => renderWebFetchPage(windowWebFetchPage(page, w)) });
      return page.signedInTo ? `(Read signed in to ${page.signedInTo} with the owner's saved credential.)\n${view}` : view;
    },
  });
}
