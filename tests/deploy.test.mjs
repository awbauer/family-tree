import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { plan, PLACEHOLDER_DB_ID } from "../tools/deploy.mjs";
import { parseJsonc } from "../tools/jsonc.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REAL_ID = "id-written-by-the-deploy-button";

test("own machine: build, then deploy with wrangler.local.jsonc; no automatic migrations", () => {
  const p = plan({ hasLocalConfig: true, templateDbId: PLACEHOLDER_DB_ID, siteBuilt: true });
  assert.equal(p.mode, "local");
  assert.deepEqual(p.steps.at(-1), ["npx", "wrangler", "deploy", "-c", "wrangler.local.jsonc"]);
  assert.ok(p.steps.some((s) => s.join(" ") === "npm run build:web"));
  assert.ok(!p.steps.some((s) => s.includes("migrations")));
});

test("Deploy to Cloudflare copy: migrations by binding name, then deploy with wrangler.jsonc", () => {
  const p = plan({ hasLocalConfig: false, templateDbId: REAL_ID, siteBuilt: true });
  assert.equal(p.mode, "template");
  assert.deepEqual(p.steps, [
    ["npx", "wrangler", "d1", "migrations", "apply", "DB", "--remote"],
    ["npx", "wrangler", "deploy"],
  ]);
});

test("Deploy to Cloudflare copy builds the site if the build step was skipped", () => {
  const p = plan({ hasLocalConfig: false, templateDbId: REAL_ID, siteBuilt: false });
  assert.equal(p.steps[0].join(" "), "npm run build:web");
});

test("refuses to deploy the placeholder database id", () => {
  assert.match(plan({ hasLocalConfig: false, templateDbId: PLACEHOLDER_DB_ID, siteBuilt: true }).error, /placeholder/);
  assert.match(plan({ hasLocalConfig: false, templateDbId: undefined, siteBuilt: true }).error, /placeholder/);
});

test("the committed template is button-ready: DB binding with the placeholder id, migrations dir, no vars", () => {
  const cfg = parseJsonc(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8"));
  const db = cfg.d1_databases.find((d) => d.binding === "DB");
  assert.equal(db.database_id, PLACEHOLDER_DB_ID);
  assert.equal(db.migrations_dir, "migrations");
  assert.equal(cfg.vars, undefined);
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts.deploy, "node tools/deploy.mjs");
  assert.match(pkg.scripts.build, /build:web/);
  for (const b of ["DB", "MEDIA", "AI"]) assert.ok(pkg.cloudflare.bindings[b].description, `description for ${b}`);
});
