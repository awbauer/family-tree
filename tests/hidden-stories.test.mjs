// Admin → Hidden stories: which stories a tree doesn't show, and why. A tree shows a story only when everyone the story
// is about is in it; people merged since count as who they became. Fictional data only.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEnv, client, migrate } from "./helpers/fake-env.mjs";
import { hiddenStories } from "../worker/hidden-stories.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "owner@example.test", EDITOR = "editor@example.test";

test("the rules: removed people hide a story everywhere, people outside a tree hide it there, merged people don't", () => {
  const full = {
    people: { A: { name: "Example Alpha", branch: "examplefield" }, B: { name: "Example Beta", branch: "exampleford" } },
    aliases: { C: "B" },
    research: { stories: [
      { slug: "fine", title: "Fine", people: ["A", "C"] },          // C was merged into B: still shows in "all"
      { slug: "gone", title: "Gone", people: ["A", "D"], body: "x" }, // D was removed
      { slug: "beta", title: "Beta", people: ["B"] },
    ] },
  };
  const trees = [{ id: "all", name: "Everyone", definition: JSON.stringify({ branches: ["*"] }) }, { id: "ef", name: "Examplefield", definition: JSON.stringify({ branches: ["examplefield"] }) }];
  const out = hiddenStories(full, trees, { D: "Example Removed" });
  const by = Object.fromEntries(out.map((s) => [s.slug, s]));
  assert.deepEqual(Object.keys(by).sort(), ["beta", "fine", "gone"]);
  assert.deepEqual(by.fine.trees.map((t) => [t.id, t.hidden, t.outside]), [["all", false, []], ["ef", true, ["B"]]]);
  assert.deepEqual(by.fine.people.find((p) => p.id === "C"), { id: "C", state: "merged", into: "B", name: "Example Beta" });
  assert.ok(by.gone.trees.every((t) => t.hidden), "a removed person hides it from every tree");
  assert.deepEqual(by.gone.people.find((p) => p.id === "D"), { id: "D", state: "removed", name: "Example Removed" });
  assert.equal(by.gone.body, "x");
  assert.deepEqual(by.beta.trees.map((t) => t.hidden), [false, true]);
  // a story every tree shows isn't listed
  assert.deepEqual(hiddenStories({ ...full, research: { stories: [{ slug: "a", people: ["A"] }] } }, [trees[0]]), []);
});

let call;
before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ft-hs-"));
  execFileSync("python3", ["tools/build.py", "--data", "example", "--out", dir, "--raw-out", join(dir, "raw.json")], { cwd: ROOT });
  const research = JSON.parse(readFileSync(join(ROOT, "example/research.json"), "utf8"));
  research.trees = [{ id: "all", name: "Everyone", definition: { branches: ["*"] } }, { id: "one", name: "One branch", definition: { branches: [research.branches[0].key] } }];
  writeFileSync(join(dir, "research.json"), JSON.stringify(research));
  execFileSync("python3", ["tools/seed_app.py", "--raw", join(dir, "raw.json"), "--bundle", join(dir, "family.json"), "--research", join(dir, "research.json"), "--out", join(dir, "seed.sql"), "--owner", OWNER, "--cutover"], { cwd: ROOT });
  const env = makeEnv();
  migrate(env.DB, ROOT);
  env.DB.execFile(join(dir, "seed.sql"));
  call = client((await import("../worker/index.js")).default, env);
  await call("PUT", "/api/admin/grants", { body: { principal: EDITOR, tree_id: "all", role: "editor" } });
});

test("GET /api/admin/stories/hidden: owner only; lists the example story the one-branch tree can't show", async () => {
  assert.equal((await call("GET", "/api/admin/stories/hidden?tree=all", { as: EDITOR })).status, 403);
  const r = await call("GET", "/api/admin/stories/hidden?tree=all");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.stories.length > 0, "the example has a story outside the one-branch tree");
  for (const s of r.data.stories) {
    assert.ok(s.trees.some((t) => t.hidden));
    assert.ok(s.trees.find((t) => t.id === "all" && !t.hidden), "everyone is in the Everyone tree");
    assert.ok(typeof s.body === "string" && s.title);
  }
  const tree = (await call("GET", "/api/tree?tree=one")).data;
  const shown = new Set((tree.research.stories || []).map((s) => s.slug));
  const all = (await call("GET", "/api/tree?tree=all")).data.research.stories.map((s) => s.slug);
  assert.deepEqual(r.data.stories.map((s) => s.slug).sort(), all.filter((x) => !shown.has(x)).sort(), "exactly what the one-branch tree doesn't show");
});
