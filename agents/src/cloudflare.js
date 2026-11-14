// Worker-level handlers that aren't HTTP: the nightly content job (cron in wrangler.jsonc).
import { settings } from "../../worker/agent/config.js";
import { runContentJob } from "./content-jobs.js";

export default {
  async scheduled(controller, env, ctx) {
    if (!settings(env).contentEnabled) return;
    ctx.waitUntil(runContentJob().then((r) => console.log("content job", JSON.stringify({ planned: r.planned, skipped: r.skipped }))));
  },
};
