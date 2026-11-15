// The agents Worker's route map. Private: no public URL (workers_dev and preview URLs are off, no routes), so only
// the site Worker reaches it, over its AGENTS service binding. Set AGENTS_TOKEN on both Workers for a second check.
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
import { Researcher } from "./agents/researcher.js";
import { Assistant } from "./agents/assistant.js";
import { QualityReviewer } from "./agents/quality.js";
import { queueProfile, runContentJob } from "./content-jobs.js";

const S = settings(env);

// Models through the Workers AI binding and your AI Gateway (logs, billing, rate limits, a kill switch in the dashboard).
// Gateway logs are on, so requests and responses (family data included) are kept in the gateway's logs, which only
// account members can read. AI_GATEWAY_LOGS=false turns them off.
setProvider(cloudflareBindingProvider({ binding: env.AI, gateway: { id: S.gateway, collectLog: S.gatewayLogs } }));
// Workers Traces get agent/model/tool spans, but never prompt or tool content.
instrument(createCloudflareTracing({ content: false }));

const app = new Hono();

app.use("*", async (c, next) => {
  if (env.AGENTS_TOKEN && c.req.header("X-Agents-Token") !== env.AGENTS_TOKEN) return c.json({ error: "Forbidden" }, 403);
  await next();
});

app.get("/health", (c) => c.json({ ok: true, model: S.model }));
app.route(RESEARCHER_PATH, createAgentRouter(Researcher));
app.route(CHAT_PATH, createAgentRouter(Assistant));
app.route(QUALITY_PATH, createAgentRouter(QualityReviewer));
app.post("/internal/profiles", async (c) => {
  const d = await c.req.json();
  return c.json(await queueProfile(String(d.person || ""), { force: !!d.force }), 202);
});
app.post("/internal/content/refresh", async (c) => c.json(await runContentJob(), 202));

export default app;
