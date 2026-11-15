// The page assistant: chats belong to one editor, messages carry the page they're on, the agent only drafts changes,
// and nothing reaches the tree until the editor applies it; then it's logged as the assistant acting on the editor's
// behalf (history, provenance, undo). The agents
// agents (Flue) are replaced by a fake env.AGENTS. Fictional example family only.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEnv, client, migrate } from "./helpers/fake-env.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "owner@example.test", EDITOR = "editor@example.test", OTHER = "other@example.test", MEMBER = "member@example.test";
let env, call, ex, calls, snapshot, Chat;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ft-chat-"));
  execFileSync("python3", ["tools/build.py", "--data", "example", "--out", dir, "--raw-out", join(dir, "raw.json")], { cwd: ROOT });
  const research = JSON.parse(readFileSync(join(ROOT, "example/research.json"), "utf8"));
  research.trees = [{ id: "all", name: "Everyone", definition: { branches: ["*"] } }];
  writeFileSync(join(dir, "research.json"), JSON.stringify(research));
  execFileSync("python3", ["tools/seed_app.py", "--raw", join(dir, "raw.json"), "--bundle", join(dir, "family.json"), "--research", join(dir, "research.json"), "--out", join(dir, "seed.sql"), "--owner", OWNER, "--cutover"], { cwd: ROOT });
  calls = [];
  snapshot = null;
  env = makeEnv({
    AGENTS: {
      fetch: async (req) => {
        const body = req.method === "POST" ? await req.json().catch(() => null) : null;
        calls.push({ url: new URL(req.url).pathname + new URL(req.url).search, method: req.method, body });
        if (req.method === "GET") return snapshot ? new Response(JSON.stringify(snapshot)) : new Response(JSON.stringify({ error: "stream_not_found" }), { status: 404 });
        return new Response(JSON.stringify({ submissionId: "sub_1", offset: "-1" }), { status: 202 });
      },
    },
  });
  migrate(env.DB, ROOT);
  env.DB.execFile(join(dir, "seed.sql"));
  call = client((await import("../worker/index.js")).default, env);
  ex = JSON.parse(readFileSync(join(dir, "family.json"), "utf8"));
  for (const [p, role] of [[EDITOR, "editor"], [OTHER, "editor"], [MEMBER, "member"]]) await call("PUT", "/api/admin/grants", { body: { principal: p, tree_id: "all", role } });
  Chat = await import("../worker/agent/chat.js");
});

const dead = () => Object.values(ex.people).find((p) => !p.living && p.events.length >= 2);
const living = () => Object.values(ex.people).find((p) => p.living);
const lastPost = () => calls.filter((c) => c.method === "POST").at(-1);
const newChat = async (as = EDITOR) => (await call("POST", "/api/chat", { as, body: { tree: "all" } })).data.chat.id;
const chatRow = (id) => env.DB.prepare("SELECT * FROM chats WHERE id = ?").bind(id).first();
const provDoc = async (id) => (await (await import("../worker/index.js")).default.fetch(new Request(`https://x.test/api/prov?tree=all&id=${id}`, { headers: { "X-Dev-Principal": EDITOR } }), env, {})).json();
const tree = async () => (await call("GET", "/api/tree?tree=all", { as: EDITOR })).data;

test("chats are for editors, and only their owner can see one", async () => {
  assert.equal((await call("POST", "/api/chat", { as: MEMBER, body: { tree: "all" } })).status, 403);
  const id = await newChat();
  assert.match(id, /^chat-/);
  assert.equal((await call("GET", `/api/chat/${id}`, { as: EDITOR })).status, 200);
  assert.equal((await call("GET", `/api/chat/${id}`, { as: OTHER })).status, 404, "another editor can't read it");
  assert.equal((await call("POST", `/api/chat/${id}/messages`, { as: OTHER, body: { text: "hi" } })).status, 404);
  assert.deepEqual((await call("GET", "/api/chat?tree=all", { as: OTHER })).data.chats, []);
  assert.equal((await call("GET", "/api/chat?tree=all", { as: EDITOR })).data.chats.length, 1);
});

test("a message carries a short pointer to the page, only when the page changes; the rest is read on demand", async () => {
  const id = await newChat(), p = dead();
  const page = { path: `person/${p.id}`, title: p.name, text: "Visible page words\nExample second line" };
  const r = await call("POST", `/api/chat/${id}/messages`, { as: EDITOR, body: { text: "When did she die?", page } });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  let sent = lastPost();
  assert.equal(sent.url, `/agents/assistant/${id}`);
  assert.equal(sent.body.kind, "user");
  assert.deepEqual(sent.body.initialData, { chatId: id });
  assert.ok(sent.body.body.startsWith("When did she die?\n\n<page_context>"));
  assert.ok(sent.body.body.includes(`profile of ${p.name} (${p.id}`));
  assert.ok(sent.body.body.includes(`get_person("${p.id}")`), "points at the record instead of carrying it");
  assert.doesNotMatch(sent.body.body, /"fid"/, "the record itself isn't in the message");
  assert.ok(!sent.body.body.includes("Visible page words"), "nor the page text");
  assert.ok(sent.body.body.length < 1200, `the pointer is short (${sent.body.body.length} chars)`);
  assert.equal(Chat.stripContext(sent.body.body), "When did she die?");
  assert.equal((await chatRow(id)).title, "When did she die?");

  await call("POST", `/api/chat/${id}/messages`, { as: EDITOR, body: { text: "And her burial?", page } });
  assert.equal(lastPost().body.body, "And her burial?", "same page: no context re-sent");
  const snap = JSON.parse((await chatRow(id)).page);
  assert.deepEqual(Chat.readPage(snap).text, page.text);
  assert.deepEqual(Chat.readPage(snap, "second").matching_lines, ["Example second line"]);
  await call("POST", `/api/chat/${id}/messages`, { as: EDITOR, body: { text: "What about this one?", page: { path: "people", title: "People", text: "List" } } });
  assert.match(lastPost().body.body, /<page_context>/, "a new page sends a new pointer");
});

test("the assistant has its own daily allowance, separate from agent runs", async () => {
  const Cfg = await import("../worker/agent/config.js");
  const s = Cfg.settings({ AI_DAILY_BUDGET_USD: "2", AI_CHAT_DAILY_BUDGET_USD: "0.5" });
  await env.DB.batch([Cfg.recordUsage(env, { input: 5000, cost: 3 })]); // agent work over its budget…
  await Cfg.checkDaily(env, s, { chat: true }); // …doesn't block the assistant
  await assert.rejects(Cfg.checkDaily(env, s), /AI budget/);
  await env.DB.batch([Cfg.recordUsage(env, { input: 600, cost: 0.6, chat: true })]);
  await assert.rejects(Cfg.checkDaily(env, s, { chat: true }), /for the assistant/);
  const id = await newChat();
  await Chat.recordChatUsage(env, id, { input: 10, output: 2 });
  assert.equal((await chatRow(id)).input_tokens, 10);
  await env.DB.prepare("DELETE FROM ai_usage").run();
});

test("an editor's assistant sees living relatives in full", async () => {
  const b = (await (await import("../worker/bundle.js")).scopedFor(env, EDITOR, "all")).bundle;
  const v = Chat.chatPersonView(b, living().id);
  assert.equal(v.living, true);
  assert.ok(v.events.length > 0);
});

test("the conversation view hides the page context and plumbing", async () => {
  const id = await newChat();
  snapshot = {
    v: 1, offset: "x", settlements: [{ submissionId: "s1", outcome: "completed" }],
    messages: [
      { id: "m1", role: "user", display: "visible", submissionId: "s1", parts: [{ type: "text", text: "Hello\n\n<page_context>\nsecret page\n</page_context>", state: "done" }] },
      { id: "m2", role: "assistant", display: "visible", submissionId: "s1", parts: [{ type: "dynamic-tool", toolName: "get_person", toolCallId: "t", state: "output-available", input: { id: "I1" }, output: {} }, { type: "text", text: "Hi.", state: "done" }] },
      { id: "m3", role: "system", display: "hidden", parts: [{ type: "text", text: "plumbing" }] },
      { id: "m4", role: "user", display: "visible", submissionId: "s2", parts: [{ type: "text", text: "And?", state: "done" }] },
    ],
  };
  const r = await call("GET", `/api/chat/${id}`, { as: EDITOR });
  snapshot = null;
  assert.equal(r.data.messages.length, 3);
  assert.equal(r.data.messages[0].text, "Hello");
  assert.deepEqual(r.data.messages[1].parts.map((x) => x.type), ["tool", "text"]);
  assert.equal(r.data.messages[1].parts[0].about, "I1");
  assert.equal(r.data.busy, true, "s2 hasn't settled");
  assert.ok(!JSON.stringify(r.data).includes("secret page"));
});

test("drafted changes are checked; nothing changes until the editor applies", async () => {
  const id = await newChat(), p = dead(), chat = await chatRow(id);
  let r = await Chat.proposeChange(env, chat, { summary: "x", reason: "y", ops: [{ op: "person.delete", id: p.id }] });
  assert.equal(r.ok, false);
  r = await Chat.proposeChange(env, chat, { summary: "x", reason: "y", ops: [{ op: "event.add", entity: "person", id: "I999999", event: { type: "Burial" } }] });
  assert.equal(r.ok, false);
  r = await Chat.proposeChange(env, chat, { summary: "", reason: "", ops: [] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 3);

  const before = (await tree()).people[p.id].events.length;
  const first = await Chat.proposeChange(env, chat, { summary: "Add an occupation", reason: "From the editor's own knowledge", ops: [{ op: "event.add", entity: "person", id: p.id, event: { type: "Occupation", value: "Example clerk" } }] });
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await Chat.proposeChange(env, chat, { summary: "Add an occupation and a note", reason: "From the editor's own knowledge", sources: [{ title: "Family letter", url: "javascript:alert(1)" }],
    ops: [{ op: "event.add", entity: "person", id: p.id, event: { type: "Occupation", value: "Example clerk", note: "Per a family letter" } }] });
  assert.equal(second.ok, true);
  assert.equal((await tree()).people[p.id].events.length, before, "proposing changes nothing");

  const view = (await call("GET", `/api/chat/${id}`, { as: EDITOR })).data;
  assert.deepEqual(view.changes.map((c) => c.status), ["superseded", "pending"], "a new proposal replaces a waiting one");
  assert.deepEqual(view.changes[1].sources, [{ title: "Family letter" }], "non-http urls are dropped");
  assert.equal((await call("POST", `/api/chat/changes/${first.id}/apply`, { as: EDITOR })).status, 409);
  assert.equal((await call("POST", `/api/chat/changes/${second.id}/apply`, { as: OTHER })).status, 404, "only the chat's editor applies");

  const ap = await call("POST", `/api/chat/changes/${second.id}/apply`, { as: EDITOR });
  assert.equal(ap.status, 200, JSON.stringify(ap.data));
  assert.equal(ap.data.change.status, "applied");
  const evs = (await tree()).people[p.id].events;
  assert.equal(evs.length, before + 1);
  assert.ok(evs.some((e) => e.type === "Occupation" && e.note === "Per a family letter"));
  const row = await env.DB.prepare("SELECT actor, actor_kind, on_behalf_of, via, reason, sources FROM changes WHERE batch_id = ? AND entity_type = 'person'").bind(ap.data.change.batch).first();
  assert.deepEqual([row.actor, row.actor_kind, row.on_behalf_of], ["agent:assistant", "agent", EDITOR], "logged as the assistant acting for the editor");
  assert.equal(row.via, `${id}#${second.id}`);
  assert.equal(row.reason, "From the editor's own knowledge");
  assert.equal(JSON.parse(row.sources)[0].title, "Family letter");
  const hist = (await call("GET", `/api/history?tree=all&id=${p.id}`, { as: EDITOR })).data.history.find((h) => h.batch === ap.data.change.batch);
  assert.deepEqual([hist.actor, hist.on_behalf_of], ["agent:assistant", EDITOR]);
  const doc = await provDoc(p.id);
  const act = doc["@graph"].find((n) => n["@id"] === `activity/${ap.data.change.batch}`);
  const bot = doc["@graph"].find((n) => n["@id"] === act["prov:wasAssociatedWith"]["@id"]);
  assert.ok(bot["@type"].includes("prov:SoftwareAgent"));
  const del = bot["prov:qualifiedDelegation"].find((d) => d["prov:hadActivity"]["@id"] === act["@id"]);
  assert.equal(doc["@graph"].find((n) => n["@id"] === del["prov:agent"]["@id"])["rdfs:label"], EDITOR, "PROV: delegated by the editor");
  const fh = (await import("../worker/prov.js")).factHistory(doc, (await tree()).people[p.id].events.find((e) => e.value === "Example clerk").fid);
  assert.deepEqual([fh[0].who, fh[0].onBehalfOf], ["agent:assistant", EDITOR]);
  const sig = lastPost();
  assert.equal(sig.url, `/agents/assistant/${id}`);
  assert.equal(sig.body.kind, "signal");
  assert.match(sig.body.body, /applied change/);
  assert.equal((await call("POST", `/api/chat/changes/${second.id}/apply`, { as: EDITOR })).status, 409, "only once");

  const un = await call("POST", `/api/chat/changes/${second.id}/undo`, { as: EDITOR });
  assert.equal(un.status, 200, JSON.stringify(un.data));
  assert.equal(un.data.change.status, "undone");
  assert.equal((await tree()).people[p.id].events.length, before);
});

test("dismissing changes nothing; a change the tree has outgrown fails cleanly", async () => {
  const id = await newChat(), p = dead(), chat = await chatRow(id);
  const a = await Chat.proposeChange(env, chat, { summary: "Note", reason: "r", ops: [{ op: "person.update", id: p.id, set: { notes: ["Example note"] } }] });
  const d = await call("POST", `/api/chat/changes/${a.id}/dismiss`, { as: EDITOR });
  assert.equal(d.data.change.status, "dismissed");
  assert.match(lastPost().body.body, /dismissed/);

  const fid = (await tree()).people[p.id].events[0].fid;
  const b = await Chat.proposeChange(env, chat, { summary: "Fix a date", reason: "r", ops: [{ op: "event.update", entity: "person", id: p.id, fid, set: { note: "checked" } }] });
  assert.equal(b.ok, true);
  // meanwhile, someone removes that fact by hand
  const rm = await call("POST", "/api/edit", { as: OWNER, body: { tree: "all", reason: "Example cleanup", ops: [{ op: "event.remove", entity: "person", id: p.id, fid }] } });
  assert.equal(rm.status, 200, JSON.stringify(rm.data));
  const ap = await call("POST", `/api/chat/changes/${b.id}/apply`, { as: EDITOR });
  assert.equal(ap.status, 409);
  const st = await env.DB.prepare("SELECT status, error FROM chat_changes WHERE id = ?").bind(b.id).first();
  assert.equal(st.status, "failed");
  assert.match(lastPost().body.body, /failed/);
});

test("losing editor access stops the assistant", async () => {
  const id = await newChat(OTHER), chat = await chatRow(id);
  await call("PUT", "/api/admin/grants", { body: { principal: OTHER, tree_id: "all", role: "member" } });
  assert.equal((await call("GET", `/api/chat/${id}`, { as: OTHER })).status, 403);
  assert.equal(await Chat.chatScope(env, chat), null);
  const r = await Chat.proposeChange(env, chat, { summary: "x", reason: "y", ops: [{ op: "person.update", id: dead().id, set: { notes: ["n"] } }] });
  assert.equal(r.ok, false);
});

test("a draft is applied once, even with two clicks", async () => {
  const id = await newChat(), p = dead(), chat = await chatRow(id);
  const a = await Chat.proposeChange(env, chat, { summary: "Note", reason: "r", ops: [{ op: "person.update", id: p.id, set: { notes: ["Example double click"] } }] });
  const [r1, r2] = await Promise.all([1, 2].map(() => call("POST", `/api/chat/changes/${a.id}/apply`, { as: EDITOR })));
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  assert.equal((await env.DB.prepare("SELECT COUNT(DISTINCT batch_id) AS n FROM changes WHERE via = ?").bind(`${id}#${a.id}`).first()).n, 1);
});
