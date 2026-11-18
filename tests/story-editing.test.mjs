// Editing stories directly (worker/stories.js) and through MCP (worker/mcp.js), against the fictional example family:
// editors write, revise and remove stories, every change is in the history and can be undone; members and agents
// suggest; nobody edits a story about someone their view doesn't show in full.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEnv, client, migrate } from "./helpers/fake-env.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "owner@example.test", EDITOR = "editor@example.test", BRANCH = "branch-editor@example.test",
  NAMES = "names-editor@example.test", MEMBER = "cousin@example.test", AGENT = "service:story-agent";
let env, call, worker;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ft-stories-"));
  execFileSync("python3", ["tools/build.py", "--data", "example", "--out", dir, "--raw-out", join(dir, "raw.json")], { cwd: ROOT });
  const research = JSON.parse(readFileSync(join(ROOT, "example/research.json"), "utf8"));
  research.trees = [{ id: "all", name: "Everyone", definition: { branches: ["*"] } },
    { id: "one", name: "One branch", definition: { branches: [research.branches[0].key] } }];
  writeFileSync(join(dir, "research.json"), JSON.stringify(research));
  execFileSync("python3", ["tools/seed_app.py", "--raw", join(dir, "raw.json"), "--bundle", join(dir, "family.json"),
    "--research", join(dir, "research.json"), "--out", join(dir, "seed.sql"), "--owner", OWNER, "--cutover"], { cwd: ROOT });
  env = makeEnv();
  migrate(env.DB, ROOT);
  env.DB.execFile(join(dir, "seed.sql"));
  worker = (await import("../worker/index.js")).default;
  call = client(worker, env);
  await call("PUT", "/api/admin/views/names", { body: { name: "Names only", filter: { living: "names-only" } } });
  await call("PUT", "/api/admin/grants", { body: { principal: EDITOR, tree_id: "all", role: "editor" } });
  await call("PUT", "/api/admin/grants", { body: { principal: BRANCH, tree_id: "one", role: "editor" } });
  await call("PUT", "/api/admin/grants", { body: { principal: NAMES, tree_id: "all", role: "editor", view_id: "names" } });
  await call("PUT", "/api/admin/grants", { body: { principal: MEMBER, tree_id: "all", role: "member" } });
  await call("PUT", "/api/admin/members/" + encodeURIComponent(AGENT), { body: { kind: "agent", display_name: "Story agent" } });
  await call("PUT", "/api/admin/grants", { body: { principal: AGENT, tree_id: "all", role: "agent" } });
});

let rid = 0;
async function tool(name, args = {}, as = EDITOR) {
  const res = await worker.fetch(new Request("https://tree.example.test/mcp", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Dev-Principal": as },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method: "tools/call", params: { name, arguments: args } }),
  }), env, { waitUntil() {} });
  const r = (await res.json()).result;
  let data = r.content[0].text;
  try { data = JSON.parse(data); } catch { /* an error message */ }
  return { error: !!r.isError, data };
}
const listed = async (as) => {
  const res = await worker.fetch(new Request("https://tree.example.test/mcp", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Dev-Principal": as },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method: "tools/list" }),
  }), env, {});
  return (await res.json()).result.tools.map((t) => t.name);
};
const SRC = [{ title: "Example parish register, 1925", note: "entry 12 (fictional)" }];
const draft = (extra = {}) => ({
  title: "The tram depot years", people: ["I4", "I17"], sources: SRC,
  body: "[[I4|George Hartley]] and his brother [[I17]] grew up near the depot.\n\nAn example story.", ...extra,
});
const story = async (slug, as = EDITOR) => tool("get_story", { slug }, as);

test("an editor writes a story: slug from the title, branch from its people, version 1", async () => {
  const r = await tool("create_story", { ...draft(), reason: "first draft" });
  assert.equal(r.error, false, r.data);
  assert.equal(r.data.story.slug, "the-tram-depot-years");
  assert.equal(r.data.story.branch, "hartley");
  assert.equal(r.data.version, 1);
  assert.ok(r.data.batch);
  const s = await story("the-tram-depot-years");
  assert.equal(s.data.version, 1);
  assert.deepEqual(s.data.people.map((p) => p.id), ["I4", "I17"]);
  // the same title again gets its own slug
  const again = await tool("create_story", draft());
  assert.equal(again.data.story.slug, "the-tram-depot-years-2");
  assert.ok((await tool("list_stories", { person: "I17" })).data.stories.length >= 2);
});

test("revising: only the fields given change, a stale version is refused, history lists each revision", async () => {
  const { data: made } = await tool("create_story", draft({ title: "Revision test" }));
  const slug = made.story.slug;
  const stale = await tool("update_story", { slug, version: 7, title: "Nope" });
  assert.equal(stale.error, true);
  assert.match(stale.data, /changed since you loaded it/);
  const r = await tool("update_story", { slug, version: 1, title: "Revision test, retitled", reason: "clearer title" });
  assert.equal(r.error, false, r.data);
  assert.equal(r.data.version, 2);
  const s = (await story(slug)).data;
  assert.equal(s.title, "Revision test, retitled");
  assert.match(s.body, /grew up near the depot/);
  assert.match(s.revised, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(s.version, 2);
  // a second editor who read version 1 can't overwrite it
  assert.equal((await tool("update_story", { slug, version: 1, body: "Overwrite" }, OWNER)).error, true);
  const h = (await tool("get_history", { story: slug })).data.history;
  assert.equal(h.length, 2);
  assert.equal(h[0].entities[0].type, "story");
  assert.equal(h[0].reason, "clearer title");
  // a revision still needs sources and visible people
  assert.match((await tool("update_story", { slug, sources: [] })).data, /no sources|isn't valid/);
});

test("every change can be undone: create, revise and delete", async () => {
  const { data: made } = await tool("create_story", draft({ title: "Undo test" }));
  const slug = made.story.slug;
  const rev = await tool("update_story", { slug, body: "A new body about [[I4]]." });
  assert.equal((await tool("revert_change", { batch: rev.data.batch, reason: "test" })).error, false);
  assert.match((await story(slug)).data.body, /grew up near the depot/);
  const del = await tool("delete_story", { slug, reason: "test" });
  assert.equal(del.data.deleted, slug);
  assert.equal((await story(slug)).error, true);
  assert.equal((await tool("revert_change", { batch: del.data.batch })).error, false);
  assert.equal((await story(slug)).data.title, "Undo test");
  assert.equal((await tool("revert_change", { batch: made.batch })).error, false);
  assert.equal((await story(slug)).error, true);
});

test("undoing a change someone has changed since is refused", async () => {
  const { data: made } = await tool("create_story", draft({ title: "Conflict test" }));
  const a = await tool("update_story", { slug: made.story.slug, body: "First revision about [[I4]]." });
  await tool("update_story", { slug: made.story.slug, body: "Second revision about [[I4]]." }, OWNER);
  const r = await tool("revert_change", { batch: a.data.batch });
  assert.equal(r.error, true);
  assert.match((await story(made.story.slug)).data.body, /Second revision/);
});

test("members and agents can't edit stories directly", async () => {
  for (const as of [MEMBER, AGENT]) {
    const names = await listed(as);
    assert.ok(!names.includes("create_story") && !names.includes("update_story") && !names.includes("delete_story"));
    assert.ok(names.includes("suggest_story"));
    assert.equal((await tool("create_story", draft(), as)).error, true);
    const direct = await call("POST", "/api/stories", { as, body: { tree: "all", ...draft() } });
    assert.equal(direct.status, 403);
  }
});

test("members suggest a story and a revision; an editor's approval applies them", async () => {
  const n = await tool("suggest_story", { ...draft({ title: "Suggested story" }), rationale: "from an interview" }, MEMBER);
  assert.equal(n.error, false, n.data);
  assert.equal((await tool("review_suggestion", { id: n.data.proposal.id, decision: "approve" })).data.status, "approved");
  assert.ok((await story("suggested-story")).data.body);

  const before = (await story("eva-comes-to-england")).data;
  const rev = await tool("suggest_story", { slug: "eva-comes-to-england", body: `${before.body}\n\nA new closing paragraph.`, reason: "add an ending" }, MEMBER);
  assert.equal(rev.error, false, rev.data);
  assert.ok(rev.data.proposal.payload.story_updates[0].sources.length, "keeps the story's citations");
  await tool("review_suggestion", { id: rev.data.proposal.id, decision: "approve" });
  assert.match((await story("eva-comes-to-england")).data.body, /A new closing paragraph/);
});

test("nobody edits a story about someone their view doesn't show in full", async () => {
  // an editor of one branch: people outside it are refused, and stories about them aren't theirs to change
  const out = await tool("create_story", { ...draft({ title: "Outside", people: ["I4", "I5"] }), tree: "one" }, BRANCH);
  assert.equal(out.error, true);
  assert.match(out.data, /I5/);
  const link = await tool("create_story", { ...draft({ title: "Outside link", body: "About [[I4]] and [[I6]]." }), tree: "one" }, BRANCH);
  assert.equal(link.error, true);
  assert.equal((await tool("update_story", { slug: "eva-comes-to-england", title: "x", tree: "one" }, BRANCH)).error, true);
  assert.equal((await tool("delete_story", { slug: "eva-comes-to-england", tree: "one" }, BRANCH)).error, true);
  assert.equal((await tool("create_story", { ...draft({ title: "Inside" }), tree: "one" }, BRANCH)).error, false);

  // living people a view reduces to a name can't be written about through that view
  const { data: living } = await tool("create_story", draft({ title: "About the living", people: ["I1"], body: "[[I1|Sam]] today." }), OWNER);
  assert.equal(living.story.slug, "about-the-living");
  assert.equal((await tool("create_story", draft({ title: "Living", people: ["I2"], body: "x" }), NAMES)).error, true);
  assert.equal((await tool("update_story", { slug: "about-the-living", title: "y" }, NAMES)).error, true);
  assert.equal((await tool("get_history", { story: "about-the-living" }, NAMES)).data.history.length, 0);
});
