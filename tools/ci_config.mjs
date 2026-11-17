#!/usr/bin/env node
// Generate wrangler.ci.jsonc for Workers Builds (Cloudflare's Git integration) from the committed template.
//
//   D1_DATABASE_ID=<uuid> node tools/ci_config.mjs     # writes wrangler.ci.jsonc (git-ignored)
//
// Set D1_DATABASE_ID as a *build* variable in Workers & Pages → family-tree → Settings → Build. The generated
// config never contains "vars" and always sets keep_vars, so deploys keep the runtime variables you set in the
// dashboard (ACCESS_TEAM_DOMAIN, ACCESS_AUD, OWNER_EMAIL, …). Refuses to write a config without a real database id.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// --d1-only: a config for `wrangler d1 …` commands only (the D1 migrations GitHub Action). Its token has just
// "D1 → Edit", so it can't look up Workers, and Durable Objects don't matter there; they're left out so the
// file can't be used to deploy by mistake.
const D1_ONLY = process.argv.includes("--d1-only");
const [srcArg, outArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const src = srcArg || join(ROOT, "wrangler.jsonc");
const out = outArg || join(ROOT, "wrangler.ci.jsonc");

import { parseJsonc } from "./jsonc.mjs";

const id = (process.env.D1_DATABASE_ID || "").trim();
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
  console.error("ci_config: set D1_DATABASE_ID (the family-tree D1 database id) as a build variable in Workers Builds.");
  process.exit(1);
}
const cfg = parseJsonc(readFileSync(src, "utf8"));
const dbs = cfg.d1_databases || [];
const db = dbs.find((d) => d.binding === "DB");
if (!db) { console.error("ci_config: no D1 binding named DB in the template."); process.exit(1); }
db.database_id = id;
if (cfg.vars && Object.keys(cfg.vars).length) console.warn(`ci_config: dropping vars ${Object.keys(cfg.vars).join(", ")} from the CI config; set them in the dashboard.`);
delete cfg.vars;
for (const env of Object.values(cfg.env || {})) delete env.vars;
cfg.keep_vars = true;
// The agents run in this Worker (worker/main.js). Sites set up before that ran them as a separate Worker,
// family-tree-agents, whose Durable Objects (chats, runs in progress) must move here, not start empty. So when that
// Worker exists, the first Durable Object migration becomes a transfer from it instead of creating new classes. After
// the first deploy v1 is applied and never runs again, whichever form it takes.
//   AGENTS_TRANSFER_FROM=<name>   transfer from <name>
//   AGENTS_TRANSFER_FROM=off      never transfer (a new site)
//   (unset)                       transfer from family-tree-agents if the Workers Builds token finds it
const LEGACY_AGENTS = "family-tree-agents";
const fromVar = (process.env.AGENTS_TRANSFER_FROM || "").trim();
if (fromVar && fromVar !== "off" && !/^[a-z0-9-]+$/.test(fromVar)) { console.error("ci_config: AGENTS_TRANSFER_FROM must be a Worker name or off"); process.exit(1); }
/** true / false, or null when it can't tell (then the build stops rather than risk leaving the agents' data behind). */
async function workerExists(name) {
  // Workers Builds gives the build an API token (wrangler deploys with it); the account id may need looking up.
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) return false; // not in Workers Builds (tests, local runs): nothing to look up
  const base = process.env.CLOUDFLARE_API_BASE_URL || "https://api.cloudflare.com/client/v4";
  const get = (path) => fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
  try {
    let account = process.env.CLOUDFLARE_ACCOUNT_ID;
    if (!account) {
      const list = await (await get("/accounts")).json();
      if (!list.success || (list.result || []).length !== 1) return null;
      account = list.result[0].id;
    }
    const r = await get(`/accounts/${account}/workers/scripts/${name}/settings`);
    return r.ok ? true : r.status === 404 ? false : null;
  } catch { return null; }
}
let transferFrom = null;
if (D1_ONLY) {
  delete cfg.durable_objects;
  delete cfg.migrations;
} else if (fromVar === "off") transferFrom = null;
else if (fromVar) transferFrom = fromVar;
else if (cfg.durable_objects) {
  const found = await workerExists(LEGACY_AGENTS);
  if (found === null) {
    console.error(`ci_config: couldn't tell whether a ${LEGACY_AGENTS} Worker exists (its agents' data would need moving here). Set the build variable AGENTS_TRANSFER_FROM to ${LEGACY_AGENTS} or off.`);
    process.exit(1);
  }
  if (found) transferFrom = LEGACY_AGENTS;
}
if (transferFrom) {
  const first = (cfg.migrations || [])[0];
  if (!first || !first.new_sqlite_classes) { console.error("ci_config: expected the first migration to create the agents' classes"); process.exit(1); }
  cfg.migrations[0] = { tag: first.tag, transferred_classes: first.new_sqlite_classes.map((c) => ({ from: c, from_script: transferFrom, to: c })) };
  console.log(`ci_config: migration ${first.tag} moves the agents' Durable Objects from ${transferFrom} (if not done already)`);
}
cfg.$schema = "node_modules/wrangler/config-schema.json";
writeFileSync(out, JSON.stringify(cfg, null, 2) + "\n");
console.log(`ci_config: wrote ${out.replace(ROOT + "/", "")} (D1 bound by id, no vars, keep_vars on${D1_ONLY ? ", D1 only: not deployable" : ""})`);
