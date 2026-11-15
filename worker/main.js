// The Worker's entry point: the site (worker/index.js) and the AI agents (agents/, Flue on Durable Objects) in one
// Worker. `npm run build:agents` builds the agents with Vite into agents/dist/agents_bundle; wrangler bundles that
// here with the site.
//
// Every request from outside goes to the site, which checks Cloudflare Access, the caller's role and the budgets. The
// agents' own routes (/agents/*, /internal/*) are never reachable from outside: the site calls them in-process through
// env.AGENTS, which has the same fetch() shape the old service binding to a separate agents Worker had.
import site from "./index.js";
import agents from "../agents/dist/agents_bundle/index.js";

// The agents' Durable Object classes must be exported by the Worker's main module.
export {
  FlueAssistantAgent, FlueProfileWriterAgent, FlueQualityReviewerAgent, FlueResearcherAgent, FlueSherlockAgent,
  FlueStoryLibrarianAgent, FlueStoryReviewerAgent, FlueStoryWriterAgent,
} from "../agents/dist/agents_bundle/index.js";

/** env as the site sees it: the bindings plus AGENTS, a fetch() straight into the agents' router. */
const withAgents = (env, ctx) => ({ ...env, AGENTS: { fetch: (input, init) => agents.fetch(new Request(input, init), env, ctx) } });

export default {
  fetch: (request, env, ctx) => site.fetch(request, withAgents(env, ctx), ctx),
  // the weekly content job (AI profiles; triggers.crons in wrangler.jsonc)
  scheduled: (controller, env, ctx) => (agents.scheduled ? agents.scheduled(controller, env, ctx) : undefined),
};
