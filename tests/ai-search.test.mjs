// AI Search (worker/ai-search.js) against the fictional example family, with a stand-in for the AI Search binding:
// what gets indexed, incremental sync, and above all that results only ever show what the caller's view shows.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEnv, client, migrate } from "./helpers/fake-env.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "owner@example.test", BRANCH = "cousin@example.test", NAMES = "aunt@example.test", ANON = "neighbour@example.test";
let env, call, worker, AiSearch;

/** An in-memory AI Search namespace: items keyed by name, search by shared words (enough to test the plumbing). */
class FakeAiSearch {
  constructor() { this.instances = new Map(); this.calls = { upload: 0, delete: 0, create: 0 }; }
  async create({ id }) { this.calls.create++; this.instances.set(id, new Map()); return this.get(id); }
  get(id) {
    const ns = this;
    const items = () => { const m = ns.instances.get(id); if (!m) throw new Error("instance not found"); return m; };
    return {
      items: {
        async list() { return { result: [...items().values()].map(({ id: i, key }) => ({ id: i, key })), result_info: { total_count: items().size } }; },
        async upload(key, content) {
          ns.calls.upload++;
          const text = typeof content === "string" ? content : await content.text();
          const itemId = `item-${ns.calls.upload}`;
          items().set(itemId, { id: itemId, key, text });
          return { id: itemId, key };
        },
        async delete(itemId) { ns.calls.delete++; if (!items().delete(itemId)) throw new Error("no such item"); },
      },
      async search({ messages, ai_search_options }) {
        const words = messages[0].content.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
        const chunks = [];
        for (const it of items().values()) {
          const t = it.text.toLowerCase();
          const n = words.filter((w) => t.includes(w)).length;
          if (n) chunks.push({ id: `${it.id}-0`, type: "text", score: n / words.length, text: it.text.slice(0, 600), item: { key: it.key, timestamp: 0, metadata: {} } });
        }
        return { search_query: messages[0].content, chunks: chunks.sort((a, b) => b.score - a.score).slice(0, ai_search_options.retrieval.max_num_results) };
      },
    };
  }
  keys(id = "family-tree") { return [...this.instances.get(id).values()].map((x) => x.key); }
}

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ft-ais-"));
  execFileSync("python3", ["tools/build.py", "--data", "example", "--out", dir, "--raw-out", join(dir, "raw.json")], { cwd: ROOT });
  const research = JSON.parse(readFileSync(join(ROOT, "example/research.json"), "utf8"));
  research.trees = [{ id: "all", name: "Everyone", definition: { branches: ["*"] } },
    { id: "one", name: "One branch", definition: { branches: [research.branches[0].key] } }];
  writeFileSync(join(dir, "research.json"), JSON.stringify(research));
  execFileSync("python3", ["tools/seed_app.py", "--raw", join(dir, "raw.json"), "--bundle", join(dir, "family.json"),
    "--research", join(dir, "research.json"), "--out", join(dir, "seed.sql"), "--owner", OWNER, "--cutover"], { cwd: ROOT });
  env = makeEnv({ AI_SEARCH: new FakeAiSearch() });
  migrate(env.DB, ROOT);
  env.DB.execFile(join(dir, "seed.sql"));
  worker = (await import("../worker/index.js")).default;
  AiSearch = await import("../worker/ai-search.js");
  call = client(worker, env);
  await call("PUT", "/api/admin/views/names", { body: { name: "Names only", filter: { living: "names-only" } } });
  await call("PUT", "/api/admin/views/anon", { body: { name: "Anonymous", filter: { living: "anonymous", notes: false } } });
  await call("PUT", "/api/admin/grants", { body: { principal: BRANCH, tree_id: "one", role: "member" } });
  await call("PUT", "/api/admin/grants", { body: { principal: NAMES, tree_id: "all", role: "member", view_id: "names" } });
  await call("PUT", "/api/admin/grants", { body: { principal: ANON, tree_id: "all", role: "member", view_id: "anon" } });
});

const search = async (q, as = OWNER, tree = "all", extra = "") => (await call("GET", `/api/search/semantic?tree=${tree}&q=${encodeURIComponent(q)}${extra}`, { as })).data;

test("the first sync creates the instance and indexes every record", async () => {
  const r = (await call("POST", "/api/admin/ai-search/sync", { body: {} })).data;
  assert.equal(r.enabled, true);
  assert.equal(env.AI_SEARCH.calls.create, 1);
  const keys = env.AI_SEARCH.keys();
  assert.ok(keys.includes("person/I4.md") && keys.includes("person/I1.md"));
  assert.ok(keys.includes("story/eva-comes-to-england.md"));
  assert.ok(keys.some((k) => /^finding\/\d+\.md$/.test(k)));
  assert.ok(keys.includes("source/S2.md"));
  assert.equal(r.failed, 0);
  assert.equal(r.more, false);
  const st = (await call("GET", "/api/admin/ai-search")).data;
  assert.equal(st.indexed, keys.length);
  assert.equal(st.synced_version, String(st.data_version));
});

test("a person's document reads like a record: events, sources, family", async () => {
  const { full } = await (await import("../worker/bundle.js")).fullBundle(env);
  const doc = AiSearch.personDoc(full, "I4");
  assert.match(doc, /^# George Hartley \(I4\)/);
  assert.match(doc, /Occupation, 1961, .*Tram conductor/);
  assert.match(doc, /Children: .*\(I2\)/);
  assert.match(doc, /Vol\. 2c, p\. 411/);
});

test("sync is incremental: nothing when nothing changed, one document after one edit", async () => {
  assert.equal((await AiSearch.sync(env)).upToDate, true);
  const before = env.AI_SEARCH.calls.upload;
  await call("POST", "/api/edit", { body: { tree: "all", reason: "test", ops: [{ op: "event.add", entity: "person", id: "I18", event: { type: "Occupation", value: "Lighthouse keeper", date: "1950" } }] } });
  const r = await AiSearch.sync(env);
  assert.equal(r.uploaded, 1);
  assert.equal(env.AI_SEARCH.calls.upload - before, 1);
  assert.equal(env.AI_SEARCH.calls.delete >= 1, true); // the old copy of I18 was replaced
  assert.equal((await search("lighthouse keeper")).results[0].id, "I18");
});

test("reports attached to someone are indexed and found by their text", async () => {
  const res = await worker.fetch(new Request("https://tree.example.test/api/attachments?tree=all&type=report&person=I6", {
    method: "POST", headers: { "X-Dev-Principal": OWNER, "Content-Type": "text/markdown", "X-Document-Name": "harbour.md", "X-Document-Title": "Harbour notes" },
    body: "# Harbour notes\n\nThe example ferry timetable lists a crossing on a stormy morning.",
  }), env, { waitUntil() {} });
  assert.equal(res.status, 201, await res.text());
  const r = await AiSearch.sync(env);
  assert.equal(r.failed, 0);
  assert.ok(env.AI_SEARCH.keys().some((k) => /^reports\/[\w-]+\.md$/.test(k)));
  const hit = (await search("ferry timetable stormy")).results.find((h) => h.kind === "document");
  assert.ok(hit, "the report is found");
  assert.equal(hit.person, "I6");
  // a member who can't see I6 never gets it
  assert.ok(!(await search("ferry timetable stormy", BRANCH, "one")).results.some((h) => h.kind === "document"));
});

test("results are only what the caller's tree and view show", async () => {
  // the owner sees living relatives in full
  const own = await search("Sam Hartley 1992");
  assert.ok(own.results.some((h) => h.id === "I1" && h.snippet));
  // one branch only: nobody outside it, ever
  const branch = await search("Costa Portland Hartley", BRANCH, "one");
  assert.ok(branch.results.length > 0);
  for (const h of branch.results) {
    assert.ok(h.kind !== "person" || ["I4", "I8", "I9", "I15", "I17"].includes(h.id), `${h.id} is outside the branch`);
    assert.doesNotMatch(JSON.stringify(h), /Costa|Portland|Sam /);
  }
  // names only: living people's records aren't results, and their facts never show in a snippet
  const names = await search("Sam Hartley 1992 Portland", NAMES);
  assert.ok(names.results.length > 0);
  assert.ok(!names.results.some((h) => ["I1", "I2", "I3", "I16"].includes(h.id)));
  // anonymous, without notes: no person snippets (their documents carry notes), and living names scrubbed
  const anon = await search("Hartley", ANON);
  assert.ok(anon.results.some((x) => x.kind === "person"));
  for (const h of anon.results.filter((x) => x.kind === "person")) assert.equal(h.snippet, undefined);
  assert.doesNotMatch(JSON.stringify(anon), /Sam Hartley|Lena Hartley|Daniel James Hartley/);
});

test("kinds filter, limits, and no binding means not available", async () => {
  const s = await search("Eva England", OWNER, "all", "&kinds=story");
  assert.ok(s.results.length && s.results.every((h) => h.kind === "story"));
  assert.ok((await search("Hartley", OWNER, "all", "&limit=2")).results.length <= 2);
  const plain = makeEnv();
  migrate(plain.DB, ROOT);
  assert.equal(AiSearch.enabled(plain), false);
  assert.deepEqual(await AiSearch.sync(plain), { enabled: false });
  const off = { ...env, AI_SEARCH_ENABLED: "false" };
  assert.equal(AiSearch.enabled(off), false);
});

test("only the owner can see or run the sync", async () => {
  assert.equal((await call("GET", "/api/admin/ai-search", { as: NAMES })).status, 403);
  assert.equal((await call("POST", "/api/admin/ai-search/sync", { as: NAMES, body: {} })).status, 403);
  assert.equal((await call("GET", "/api/me")).data.aiSearch, true);
});

test("MCP: semantic_search for everyone, the index tools for the owner", async () => {
  const rpc = async (method, params, as = OWNER) => {
    const res = await worker.fetch(new Request("https://tree.example.test/mcp", { method: "POST", headers: { "Content-Type": "application/json", "X-Dev-Principal": as },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), env, { waitUntil() {} });
    return (await res.json()).result;
  };
  const names = (await rpc("tools/list", {}, NAMES)).tools.map((t) => t.name);
  assert.ok(names.includes("semantic_search") && !names.includes("reindex_search"));
  assert.ok((await rpc("tools/list", {})).tools.some((t) => t.name === "reindex_search"));
  const r = await rpc("tools/call", { name: "semantic_search", arguments: { query: "lighthouse keeper" } });
  assert.equal(JSON.parse(r.content[0].text).results[0].id, "I18");
  const st = await rpc("tools/call", { name: "search_index_status", arguments: {} });
  assert.equal(JSON.parse(st.content[0].text).enabled, true);
});

test("removed records leave the index", async () => {
  const { full } = await (await import("../worker/bundle.js")).fullBundle(env);
  const finding = full.research.findings[0];
  env.DB.exec(`DELETE FROM findings WHERE id = ${finding.id}; UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'data_version';`);
  const r = await AiSearch.sync(env);
  assert.equal(r.removed, 1);
  assert.ok(!env.AI_SEARCH.keys().includes(`finding/${finding.id}.md`));
});
