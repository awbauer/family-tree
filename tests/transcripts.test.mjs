// Transcripts on photos and attachments (media.attach / media.update `transcript`): writing them through the API and
// MCP, reading them back where the file is, who sees them, and where else they go (search, agents, exports).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEnv, client, migrate } from "./helpers/fake-env.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "owner@example.test", EDITOR = "editor@example.test", MEMBER = "cousin@example.test", NOMEDIA = "aunt@example.test";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
let env, call, worker, photo, doc;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ft-tr-"));
  execFileSync("python3", ["tools/build.py", "--data", "example", "--out", dir, "--raw-out", join(dir, "raw.json")], { cwd: ROOT });
  const research = JSON.parse(readFileSync(join(ROOT, "example/research.json"), "utf8"));
  research.trees = [{ id: "all", name: "Everyone", definition: { branches: ["*"] } }];
  writeFileSync(join(dir, "research.json"), JSON.stringify(research));
  execFileSync("python3", ["tools/seed_app.py", "--raw", join(dir, "raw.json"), "--bundle", join(dir, "family.json"),
    "--research", join(dir, "research.json"), "--out", join(dir, "seed.sql"), "--owner", OWNER, "--cutover"], { cwd: ROOT });
  env = makeEnv();
  migrate(env.DB, ROOT);
  env.DB.execFile(join(dir, "seed.sql"));
  worker = (await import("../worker/index.js")).default;
  call = client(worker, env);
  await call("PUT", "/api/admin/views/nomedia", { body: { name: "No media", filter: { media: false } } });
  await call("PUT", "/api/admin/grants", { body: { principal: EDITOR, tree_id: "all", role: "editor" } });
  await call("PUT", "/api/admin/grants", { body: { principal: MEMBER, tree_id: "all", role: "member" } });
  await call("PUT", "/api/admin/grants", { body: { principal: NOMEDIA, tree_id: "all", role: "member", view_id: "nomedia" } });
  // a photo on I4, and a document shared by I4 and I6
  const up = await tool("upload_media", { name: "census.png", content_type: "image/png", data_base64: PNG }, EDITOR);
  photo = up.data.key;
  await call("POST", "/api/edit", { as: EDITOR, body: { tree: "all", reason: "test", ops: [{ op: "media.attach", person: "I4", file: photo, caption: "Census page" }] } });
  const att = await tool("add_attachment", { person: "I4", also: ["I6"], name: "letter.pdf", data_base64: Buffer.from("%PDF-1.4 example").toString("base64") }, EDITOR);
  assert.equal(att.error, false, JSON.stringify(att.data));
  doc = att.data.file;
});

let rid = 0;
async function tool(name, args = {}, as = OWNER) {
  const res = await worker.fetch(new Request("https://tree.example.test/mcp", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Dev-Principal": as },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method: "tools/call", params: { name, arguments: args } }),
  }), env, { waitUntil() {} });
  const r = (await res.json()).result;
  const c = r.content[0];
  let data = c.text;
  if (c.type === "text") try { data = JSON.parse(c.text); } catch { /* text */ }
  return { error: !!r.isError, data, content: r.content };
}
const entry = async (pid, file, as = OWNER) => ((await call("GET", "/api/tree?tree=all", { as })).data.research.media[pid] || []).find((m) => m.file === file);

test("the API: media.update sets, replaces and clears a transcript; too long is refused", async () => {
  const set = (transcript) => call("POST", "/api/edit", { as: EDITOR, body: { tree: "all", reason: "test", ops: [{ op: "media.update", person: "I4", file: photo, set: { transcript } }] } });
  assert.equal((await set("Line one\r\nLine two")).status, 200);
  assert.equal((await entry("I4", photo)).transcript, "Line one\nLine two");
  assert.equal((await set("")).status, 200);
  assert.equal((await entry("I4", photo)).transcript, undefined);
  const long = await set("x".repeat(100001));
  assert.equal(long.status, 422);
  assert.match(long.data.error, /at most 100,000 characters/);
  // media.attach takes one too
  const r = await call("POST", "/api/edit", { as: EDITOR, body: { tree: "all", reason: "test", ops: [{ op: "media.attach", person: "I5", file: photo, caption: "Census page", transcript: "Eva, lodger" }] } });
  assert.equal(r.status, 200);
  assert.equal((await entry("I5", photo)).transcript, "Eva, lodger");
});

test("MCP set_transcript: editors save it on every visible copy of the file, and it can be undone", async () => {
  const r = await tool("set_transcript", { file: doc, transcript: "Dear Mother, we arrived at the harbour on Tuesday.", reason: "read from the scan" }, EDITOR);
  assert.equal(r.error, false, JSON.stringify(r.data));
  assert.deepEqual(r.data.people.sort(), ["I4", "I6"]);
  assert.match((await entry("I6", doc)).transcript, /arrived at the harbour/);
  const undo = await tool("revert_change", { batch: r.data.batch }, EDITOR);
  assert.equal(undo.error, false);
  assert.equal((await entry("I4", doc)).transcript, undefined);
  await tool("set_transcript", { file: doc, transcript: "Dear Mother, we arrived at the harbour on Tuesday." }, EDITOR);
  // only one person's copy
  await tool("set_transcript", { file: doc, person: "I6", transcript: "A different reading" }, EDITOR);
  assert.equal((await entry("I6", doc)).transcript, "A different reading");
  assert.match((await entry("I4", doc)).transcript, /harbour/);
  await tool("set_transcript", { file: doc, person: "I6", transcript: "Dear Mother, we arrived at the harbour on Tuesday." }, EDITOR);
});

test("members suggest a transcript; approving it saves it", async () => {
  const r = await tool("set_transcript", { file: photo, person: "I4", transcript: "1939 Register, household of George" }, MEMBER);
  assert.equal(r.error, false, JSON.stringify(r.data));
  assert.ok(r.data.proposal);
  assert.equal((await entry("I4", photo)).transcript, undefined);
  const ok = await tool("review_suggestion", { id: r.data.proposal, decision: "approve" }, EDITOR);
  assert.equal(ok.data.status, "approved");
  assert.equal((await entry("I4", photo)).transcript, "1939 Register, household of George");
});

test("reading it back: get_person (shortened when long), list_attachments, get_media, get_attachment", async () => {
  const p = (await tool("get_person", { id: "I4" })).data;
  assert.equal(p.media.find((m) => m.file === photo).transcript, "1939 Register, household of George");
  assert.match(p.attachments.find((m) => m.file === doc).transcript, /harbour/);
  const img = await tool("get_media", { file: photo });
  assert.equal(img.content[0].type, "image");
  assert.deepEqual(JSON.parse(img.content[1].text), { transcript: "1939 Register, household of George" });
  const att = await tool("get_attachment", { file: doc });
  const parts = att.content.map((c) => (c.type === "text" ? JSON.parse(c.text) : c));
  assert.ok(parts.some((x) => x.transcript && /harbour/.test(x.transcript)) || /harbour/.test(JSON.stringify(att.data)));
  // a long transcript is shortened in listings and complete in get_media
  const long = "Entry. ".repeat(600).trim();
  await tool("set_transcript", { file: photo, person: "I4", transcript: long }, EDITOR);
  const short = (await tool("get_person", { id: "I4" })).data.media.find((m) => m.file === photo);
  assert.equal(short.transcript_truncated, true);
  assert.equal(short.transcript_length, long.length);
  assert.equal(JSON.parse((await tool("get_media", { file: photo })).content[1].text).transcript, long);
  await tool("set_transcript", { file: photo, person: "I4", transcript: "1939 Register, household of George" }, EDITOR);
});

test("a view without media shows no transcripts anywhere", async () => {
  assert.equal((await call("GET", "/api/tree?tree=all", { as: NOMEDIA })).data.research.media.I4, undefined);
  const p = (await tool("get_person", { id: "I4" }, NOMEDIA)).data;
  assert.doesNotMatch(JSON.stringify(p), /harbour|household of George/);
  assert.equal((await tool("get_media", { file: photo }, NOMEDIA)).error, true);
  assert.equal((await tool("set_transcript", { file: photo, transcript: "x" }, NOMEDIA)).error, true);
  const hits = (await tool("search_text", { query: "harbour" }, NOMEDIA)).data;
  assert.doesNotMatch(JSON.stringify(hits), /harbour on Tuesday/);
});

test("linking a document to more people copies its transcript", async () => {
  const r = await tool("link_document", { file: doc, people: ["I18"] }, EDITOR);
  assert.equal(r.error, false, JSON.stringify(r.data));
  assert.match((await entry("I18", doc)).transcript, /harbour/);
});

test("keyword search finds words in a transcript", async () => {
  const s = (await tool("search_text", { query: "harbour Tuesday" })).data;
  const hit = (s.results || s.hits || s.people || []).find?.((h) => h.id === "I4") || JSON.stringify(s).includes('"I4"');
  assert.ok(hit, JSON.stringify(s).slice(0, 400));
  assert.match(JSON.stringify(s), /transcript/);
});

test("the agents read a stored transcript instead of transcribing the image again", async () => {
  const { readRecordFile } = await import("../worker/agent/chat-files.js");
  const { scopeFor, fullBundle } = await import("../worker/bundle.js");
  const { resolveAccess, grantFor } = await import("../worker/auth.js");
  const access = await resolveAccess(env, { principal: OWNER, kind: "person" });
  const b = await scopeFor(env, access, grantFor(access, "all"));
  let modelCalls = 0;
  const out = await readRecordFile({ ...env, AI: { run: async () => { modelCalls++; return { response: "fresh" }; } } }, b, { person: "I4", file: photo });
  assert.equal(out.method, "stored_transcript");
  assert.match(out.text, /1939 Register/);
  assert.equal(modelCalls, 0);
  // AI Search's person document includes it
  const { personDoc } = await import("../worker/ai-search.js");
  assert.match(personDoc((await fullBundle(env)).full, "I4"), /Transcript: 1939 Register/);
});

test("exports carry the transcript", async () => {
  const ged = (await call("GET", "/api/export.ged?tree=all", { as: EDITOR })).data;
  assert.match(ged, /Transcript: 1939 Register/);
  const gx = (await call("GET", "/api/export.gedcomx?tree=all", { as: EDITOR })).data;
  assert.match(JSON.stringify(gx), /"https:\/\/family-tree\.example\/terms\/transcript":"1939 Register/);
});
