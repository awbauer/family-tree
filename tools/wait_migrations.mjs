#!/usr/bin/env node
// Used by `npm run deploy:ci` (Workers Builds): before deploying, wait until the production D1 database has no
// pending migrations. The GitHub Action .github/workflows/d1-migrations.yml applies them from the same push, so
// this avoids deploying code ahead of its schema. Waits up to WAIT_MIGRATIONS_SECONDS (default 600), polling
// every 15 seconds; fails the deploy if migrations are still pending after that. If the database can't be
// queried at all (e.g. the build token can't read D1), it warns and lets the deploy continue.
import { spawnSync } from "node:child_process";

const config = process.argv[2] || "wrangler.ci.jsonc";
const limit = Number(process.env.WAIT_MIGRATIONS_SECONDS || 600) * 1000;
const every = Number(process.env.WAIT_MIGRATIONS_POLL_SECONDS || 15) * 1000;
const bin = process.env.WRANGLER_BIN || "npx";
const args = process.env.WRANGLER_BIN ? [] : ["wrangler"];

/** "pending" | "none" | "unknown" from `wrangler d1 migrations list` output. */
export function classify(code, text) {
  if (code === 0 && /No migrations to apply/i.test(text)) return "none";
  if (code === 0 && /\b\d{4}_[\w-]+\.sql\b/.test(text)) return "pending";
  return "unknown";
}

const started = Date.now();
for (;;) {
  const r = spawnSync(bin, [...args, "d1", "migrations", "list", "DB", "-c", config, "--remote"], { encoding: "utf8", env: { ...process.env, CI: "true" } });
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  const state = classify(r.status, out);
  if (state === "none") { console.log("wait_migrations: database schema is current"); process.exit(0); }
  if (state === "unknown") {
    console.warn("wait_migrations: couldn't read migration status (does the build token have D1 read access?); deploying without the check.");
    console.warn(out.split("\n").filter((l) => /error|✘/i.test(l)).slice(0, 3).join("\n"));
    process.exit(0);
  }
  const pending = [...new Set(out.match(/\b\d{4}_[\w-]+\.sql\b/g))];
  if (Date.now() - started > limit) {
    console.error(`wait_migrations: still pending after ${limit / 1000}s: ${pending.join(", ")}. Run the "D1 migrations" GitHub Action, then retry this build.`);
    process.exit(1);
  }
  console.log(`wait_migrations: pending ${pending.join(", ")}; waiting for the D1 migrations GitHub Action…`);
  await new Promise((res) => setTimeout(res, every));
}
