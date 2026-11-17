#!/usr/bin/env node
// `npm run deploy`: picks the right deploy for where it runs.
//
//   Your own machine (wrangler.local.jsonc exists): build the site and the agents, then deploy with your local config.
//     Schema migrations stay a separate, deliberate step (npm run db:migrate).
//   A copy made by the Deploy to Cloudflare button (Workers Builds, no wrangler.local.jsonc): the button has created
//     the D1 database and written its id into wrangler.jsonc, and the build step (npm run build) has built the site.
//     Apply pending D1 migrations by binding name (as Cloudflare's docs recommend for deploy buttons), then deploy.
//
// Owners who connected Workers Builds by hand use `npm run deploy:ci` instead (docs/agents/operations.md).
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./jsonc.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PLACEHOLDER_DB_ID = "00000000-0000-0000-0000-000000000000";

/** The commands to run, or { error } when deploying can't work. Pure, so tests can check every case. */
export function plan({ hasLocalConfig, templateDbId, siteBuilt }) {
  const build = [["npm", "run", "build:web"], ["npm", "run", "build:agents"]];
  if (hasLocalConfig) return { mode: "local", steps: [...build, ["npx", "wrangler", "deploy", "-c", "wrangler.local.jsonc"]] };
  if (!templateDbId || templateDbId === PLACEHOLDER_DB_ID) {
    return {
      error: "deploy: wrangler.jsonc still has the placeholder D1 database id and there is no wrangler.local.jsonc.\n" +
        "  On your own machine: cp wrangler.jsonc wrangler.local.jsonc and put your database id in it (npx wrangler d1 list).\n" +
        "  In Workers Builds you connected by hand: set the deploy command to `npm run deploy:ci` (docs/agents/operations.md).",
    };
  }
  return {
    mode: "template",
    steps: [
      ...(siteBuilt ? [] : build),
      ["npx", "wrangler", "d1", "migrations", "apply", "DB", "--remote"],
      ["npx", "wrangler", "deploy"],
    ],
  };
}

function main() {
  const hasLocalConfig = existsSync(join(ROOT, "wrangler.local.jsonc"));
  const cfg = parseJsonc(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8"));
  const db = (cfg.d1_databases || []).find((d) => d.binding === "DB");
  const siteBuilt = existsSync(resolve(ROOT, cfg.assets?.directory || "dist/site", "index.html"));
  const p = plan({ hasLocalConfig, templateDbId: db?.database_id, siteBuilt });
  if (p.error) { console.error(p.error); process.exit(1); }
  console.log(`deploy: ${p.mode === "local" ? "using wrangler.local.jsonc" : "using wrangler.jsonc (Deploy to Cloudflare copy)"}`);
  for (const [cmd, ...args] of p.steps) {
    console.log(`deploy: ${cmd} ${args.join(" ")}`);
    // Non-interactive in Workers Builds; on your own machine wrangler keeps its usual prompts.
    const env = p.mode === "template" ? { ...process.env, CI: process.env.CI || "true" } : process.env;
    const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", env });
    if (r.status !== 0) process.exit(r.status || 1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
