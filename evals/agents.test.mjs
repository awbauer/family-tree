import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { client, makeEnv, migrate } from "../tests/helpers/fake-env.mjs";
import { env, hookImports, scriptedAgent } from "./flue-harness.mjs";
import worker from "../worker/index.js";
import { prepareProfile, prepareStory } from "../worker/agent/content.js";
import { loadRun } from "../worker/agent/runs.js";

const OWNER = "owner@example.test";
const EDITOR = "editor@example.test";
const RESTRICTED = "restricted@example.test";
const { parse } = createRequire(new URL("../agents/package.json", import.meta.url))("valibot");
const root = new URL("..", import.meta.url);
let call, agents;
before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ft-agent-eval-"));
  try {
    const build = (script, args) => execFileSync("python3", [script, ...args], { cwd: root });
    build("tools/build.py", ["--data", "example", "--out", dir, "--raw-out", join(dir, "raw.json")]);
    const research = JSON.parse(readFileSync(new URL("example/research.json", root), "utf8"));
    research.trees = [{ id: "all", name: "Everyone", definition: { branches: ["*"] } }];
    writeFileSync(join(dir, "research.json"), JSON.stringify(research));
    build("tools/seed_app.py", ["--raw", join(dir, "raw.json"), "--bundle", join(dir, "family.json"),
      "--research", join(dir, "research.json"), "--out", join(dir, "seed.sql"), "--owner", OWNER, "--cutover"]);
    Object.assign(env, makeEnv({ AGENTS: { fetch: async () => new Response("{}", { status: 202 }) } }));
    migrate(env.DB, fileURLToPath(root));
    env.DB.execFile(join(dir, "seed.sql"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  call = client(worker, env);
  assert.equal((await call("PUT", "/api/admin/grants", { body: { principal: EDITOR, tree_id: "all", role: "editor" } })).status, 200);
  assert.equal((await call("PUT", "/api/admin/views/names", { body: { name: "Names only", filter: { living: "names-only" } } })).status, 200);
  assert.equal((await call("PUT", "/api/admin/grants", { body: { principal: RESTRICTED, tree_id: "all", role: "editor", view_id: "names" } })).status, 200);
  const hook = hookImports();
  try {
    agents = Object.assign({}, ...await Promise.all(
      ["assistant", "researcher", "sherlock", "quality", "stories", "library", "content"]
        .map((module) => import(`../agents/src/agents/${module}.js`)),
    ));
  } finally {
    hook.deregister();
  }
});

after(() => env.DB?.db.close());

const asAgent = (name, data) => scriptedAgent(agents[name], data, parse);
const proposals = () => env.DB.prepare("SELECT * FROM proposals ORDER BY id").all().then((r) => r.results);
const startRun = async (kind, args, as = EDITOR) => {
  const r = await call("POST", "/api/agent/runs", { as, body: { tree: "all", kind, ...args } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const agent = asAgent({
    research: "Researcher", relatives: "Sherlock", quality: "QualityReviewer", story: "StoryWriter", library: "StoryLibrarian",
  }[kind], { runId: r.data.run.id });
  await agent.start();
  return { agent, id: r.data.run.id };
};

test("assistant inspects the selected report and stages an evidence-backed correction for approval", async () => {
  const report = "# Fictional register transcript\n\nThe register says the entry was amended.\n";
  const upload = await worker.fetch(new Request("https://tree.example.test/api/attachments?person=I4&type=report&tree=all&source=S2", {
    method: "POST", headers: { "X-Dev-Principal": EDITOR, "X-Document-Name": "register.md" }, body: report,
  }), env);
  assert.equal(upload.status, 201);
  const { file } = await upload.json();
  const chat = await call("POST", "/api/chat", { as: EDITOR, body: { tree: "all" } });
  assert.equal(chat.status, 201);
  const chatId = chat.data.chat.id;
  const message = await call("POST", `/api/chat/${chatId}/messages`, { as: EDITOR, body: {
    text: "Read this report and draft a status note recording what the transcript says.",
    page: { path: `person/I4?attachment=${encodeURIComponent(file)}`, title: "Fictional record" },
  } });
  assert.equal(message.status, 202);
  const agent = asAgent("Assistant", { chatId });
  assert.match(agent.prompt, /genealog/i);
  assert.ok(!agent.tools.includes("web_fetch"));
  assert.ok((await agent.call("list_record_files", {})).files.some((item) => item.file === file));
  const evidence = await agent.call("read_record_file", {});
  assert.equal(evidence.method, "original_text");
  assert.equal(evidence.text, report);
  const before = await agent.call("get_person", { id: "I4" });
  const note = "The fictional transcript records an amended entry.";
  const staged = await agent.call("propose_change", {
    summary: "Update the research status note", reason: note, sources: [{ title: "Fictional register transcript", note }],
    ops: [{ op: "person.update", id: "I4", set: { research_status: "disputed", status_note: note } }],
  });
  assert.ok(staged.change);
  assert.deepEqual(await agent.call("get_person", { id: "I4" }), before);
});

test("research retains a negative search for review and stops after successful submission", async () => {
  const { agent, id } = await startRun("research", { person: "I4" });
  assert.ok((await agent.call("get_person", { id: "I4" })).events.length);
  const start = (await proposals()).length;
  const log = { person: "I4", searched: "Fictional parish index, surname and year", result: "nil" };
  assert.match(await agent.call("submit_results", {
    summary: "The fictional index contained no matching entry.", batch: { log: [log] },
  }), /suggestion/);
  assert.equal((await loadRun(env, id)).status, "succeeded");
  const rows = await proposals();
  assert.equal(rows.length, start + 1);
  assert.equal(rows.at(-1).status, "open");
  assert.equal(JSON.parse(rows.at(-1).payload).log[0].result, "nil");
  await assert.rejects(agent.call("get_person", { id: "I4" }), /succeeded/);
});

test("research reminds once and then fails a run that never submits a result", async () => {
  const { agent, id } = await startRun("research", { person: "I4" });
  const signals = await agent.finish();
  assert.equal(signals.length, 1);
  assert.match(signals[0].body, /submit_results/);
  assert.deepEqual(await agent.finish(), []);
  assert.equal((await loadRun(env, id)).status, "failed");
});

test("relative finder rejects an unsupported relative and accepts a negative search log", async () => {
  const { agent, id } = await startRun("relatives", { person: "I4" });
  const baseline = (await proposals()).length;
  const input = {
    summary: "A possible relative still needs evidence.",
    log: [{ searched: "Fictional household register", result: "inconclusive" }],
  };
  await assert.rejects(agent.call("submit_relatives", { ...input, candidates: [{
    given: "Fictional", surname: "Example", relation: "child", finding: "A possible child", confidence: "low", sources: [],
  }] }), /source/i);
  assert.equal((await proposals()).length, baseline);
  await agent.call("submit_relatives", input);
  assert.equal((await loadRun(env, id)).status, "succeeded");
});

test("data-quality dry run requires evidence and leaves the reviewed to-do unchanged", async () => {
  const { agent, id } = await startRun("quality", { scope: "todos", limit: 1, dry_run: true });
  const [item] = JSON.parse((await loadRun(env, id)).options).items;
  const todo = () => env.DB.prepare("SELECT * FROM todos WHERE id = ?").bind(item.id).first();
  const original = await todo();
  await assert.rejects(agent.call("finish_review", { summary: "Finished." }), /Decide these first/);
  await assert.rejects(agent.call("record_decision", { item: item.ref, verdict: "resolved", note: "Resolved." }), /evidence/);
  const outcome = await agent.call("record_decision", { item: item.ref, verdict: "still_valid", note: "The records leave it open." });
  assert.equal(outcome.status, "would");
  await agent.call("finish_review", { summary: "One to-do remains open." });
  assert.equal((await loadRun(env, id)).status, "succeeded");
  assert.deepEqual(await todo(), original);
});

test("story writer rejects a draft without paragraph evidence and librarian refuses a private subject", async () => {
  const writer = await startRun("story", { mode: "draft", people: ["I4"] });
  const original = (await proposals()).length;
  await assert.rejects(writer.agent.call("submit_story", {
    summary: "A draft for review.", title: "A fictional history", body: "A paragraph with no supporting notes. ".repeat(8),
  }), /notes:/);
  assert.equal((await proposals()).length, original);
  const { agent } = await startRun("library", { n: 1 }, RESTRICTED);
  const candidates = await agent.call("get_candidates", {});
  assert.ok(candidates.some((candidate) => candidate.people.includes("I4")));
  const { data: tree } = await call("GET", "/api/tree?tree=all", { as: RESTRICTED });
  const privatePerson = Object.values(tree.people).find((person) => person.private);
  assert.ok(privatePerson);
  assert.ok(candidates.every((candidate) => !candidate.people.includes(privatePerson.id)));
  await assert.rejects(agent.call("commission_story", {
    people: [privatePerson.id], brief: "Use only the records available in the example tree.",
  }), /private in this tree/i);
});

test("scheduled profile writer and story reviewer validate and persist their tool outputs", async () => {
  const { hash } = await prepareProfile(env, "I4");
  const writer = asAgent("ProfileWriter", { person: "I4", hash });
  await assert.rejects(writer.call("save_profile", { text: "Too short" }));
  const text = "The fictional family tree records this person and links the records used in this example.";
  await writer.call("save_profile", { text });
  const saved = await env.DB.prepare("SELECT text, source_hash FROM profiles WHERE person_id = 'I4'").first();
  assert.deepEqual(saved, { text, source_hash: hash });

  const story = JSON.parse((await env.DB.prepare("SELECT data FROM stories LIMIT 1").first()).data);
  const prepared = await prepareStory(env, story.slug);
  const reviewer = asAgent("StoryReviewer", { slug: story.slug, hash: prepared.hash });
  const count = (await proposals()).length;
  await reviewer.call("record_verdict", { up_to_date: true, reason: "The records agree.", title: story.title, body: story.body });
  assert.equal((await proposals()).length, count);
  assert.equal(await env.DB.prepare("SELECT outcome FROM content_checks WHERE key = ?").bind(`story:${story.slug}`).first("outcome"), "up to date");
});
