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
const src = process.argv[2] || join(ROOT, "wrangler.jsonc");
const out = process.argv[3] || join(ROOT, "wrangler.ci.jsonc");

// Strip line and block comments and trailing commas (outside strings).
export function parseJsonc(text) {
  let res = "", inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inStr) { res += c; if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; res += c; continue; }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; res += "\n"; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; continue; }
    res += c;
  }
  return JSON.parse(res.replace(/,(\s*[}\]])/g, "$1"));
}

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
cfg.$schema = "node_modules/wrangler/config-schema.json";
writeFileSync(out, JSON.stringify(cfg, null, 2) + "\n");
console.log(`ci_config: wrote ${out.replace(ROOT + "/", "")} (D1 bound by id, no vars, keep_vars on)`);
