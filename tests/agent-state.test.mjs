// Flue rejects two usePersistentState declarations with the same name in one render, and the failure only shows up
// at run time, as every message to that agent failing. The usage hook (agents/src/agents/usage.js) owns its state
// names; agents must not declare them again. A static check, since the agents only run inside the Flue runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "agents", "src", "agents");
const names = (src) => [...src.matchAll(/usePersistentState\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
const hookOwned = names(readFileSync(join(DIR, "usage.js"), "utf8"));

test("no agent declares a state name twice, its own or the usage hook's", () => {
  assert.ok(hookOwned.includes("usage_recorded"));
  for (const f of readdirSync(DIR).filter((x) => x.endsWith(".js") && x !== "usage.js")) {
    const src = readFileSync(join(DIR, f), "utf8");
    // agent functions in this file; each renders its own hooks plus the usage hook if it calls it
    for (const block of src.split(/\nexport function /).slice(1)) {
      const own = names(block);
      const all = [...own, ...(/\buseUsage\(/.test(block) ? hookOwned : [])];
      const dup = all.filter((n, i) => all.indexOf(n) !== i);
      assert.deepEqual(dup, [], `${f} ${block.split("(")[0]}: duplicate state name(s) ${dup.join(", ")}`);
    }
  }
});
