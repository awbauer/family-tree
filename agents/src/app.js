// The agents' route map. Not reachable from outside: worker/main.js sends every outside request to the site, and the
// site calls these routes in-process through env.AGENTS after its own checks (Access, role, budgets).
import { Hono } from "hono";
import { env } from "cloudflare:workers";
import { instrument, setProvider } from "@flue/runtime";
import { createAgentRouter } from "@flue/runtime/routing";
import { createCloudflareTracing } from "@flue/runtime/cloudflare";
import { cloudflareBindingProvider } from "@flue/runtime/cloudflare/workers-ai";
import { settings } from "../../worker/agent/config.js";
import { RESEARCHER_PATH } from "../../worker/agent/runs.js";
import { CHAT_PATH } from "../../worker/agent/chat.js";
import { QUALITY_PATH } from "../../worker/agent/quality.js";
import { STORY_PATH } from "../../worker/agent/stories.js";
import { LIBRARY_PATH } from "../../worker/agent/library.js";
import { RELATIVES_PATH } from "../../worker/agent/relatives.js";
import { Researcher } from "./agents/researcher.js";
import { Assistant } from "./agents/assistant.js";
import { QualityReviewer } from "./agents/quality.js";
import { StoryWriter } from "./agents/stories.js";
import { StoryLibrarian } from "./agents/library.js";
import { Sherlock } from "./agents/sherlock.js";
import { queueProfile, runContentJob } from "./content-jobs.js";

const S = settings(env);

// Models through the Workers AI binding and your AI Gateway (logs, billing, rate limits, a kill switch in the dashboard).
// Gateway logs are on, so requests and responses (family data included) are kept in the gateway's logs, which only
// account members can read. AI_GATEWAY_LOGS=false turns them off.
setProvider(cloudflareBindingProvider({ binding: env.AI, gateway: { id: S.gateway, collectLog: S.gatewayLogs } }));
// Workers Traces get agent/model/tool spans, but never prompt or tool content.
instrument(createCloudflareTracing({ content: false }));

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, agents: S.agents }));
app.route(RESEARCHER_PATH, createAgentRouter(Researcher));
app.route(CHAT_PATH, createAgentRouter(Assistant));
app.route(QUALITY_PATH, createAgentRouter(QualityReviewer));
app.route(STORY_PATH, createAgentRouter(StoryWriter));
app.route(LIBRARY_PATH, createAgentRouter(StoryLibrarian));
app.route(RELATIVES_PATH, createAgentRouter(Sherlock));
app.post("/internal/profiles", async (c) => {
  const d = await c.req.json();
  return c.json(await queueProfile(String(d.person || ""), { force: !!d.force }), 202);
});
app.post("/internal/content/refresh", async (c) => c.json(await runContentJob(), 202));

export default app;
