// HTTP routes for the page assistant (worker/agent/chat.js). Editors only. A chat lives in its owner's ChatStore
// Durable Object (addressed by the caller's own principal, so nobody can reach another editor's chats) and its
// conversation in a Flue Durable Object in the agents Worker. This Worker adds the page context to each message and
// applies the changes the editor confirms, logged as made by the assistant on the editor's behalf.
//
//   GET  /api/chat?tree=                       your recent chats in this tree
//   POST /api/chat                             {tree}  start a chat
//   GET  /api/chat/:id                         the conversation (poll while busy) and the changes it drafted
//   POST /api/chat/:id/messages                {text, page: {path, title, text}}  send a message
//   POST /api/chat/:id/abort                   stop the reply in progress
//   POST /api/chat/changes/:cid/apply|dismiss|undo
import { can, grantFor } from "../auth.js";
import { fail, json } from "../http.js";
import { applyAndCommit, revertBatch, isConflict, newBatchId } from "../store.js";
import { settings, agentsEnabled, checkDaily, BudgetError } from "./config.js";
import { agentsFetch } from "./routes.js";
import { CHAT_PATH, ASSISTANT, chatStore, chatScope, checkChange, pageContext, composeMessage, stripContext } from "./chat.js";

const MAX_TEXT = 4000;

function editor(c, g) {
  if (!g || !can.review(g) || c.access.kind !== "person") fail(403, "The assistant is for editors.");
}
function needAgents(c) {
  if (!agentsEnabled(c.env)) fail(503, "The assistant isn't set up yet: it runs in the agents Worker. See docs/agents/operations.md → Page assistant.");
}
const mine = (c) => chatStore(c.env, c.access.principal);

/** The caller's chat, if they still edit its tree; 404 otherwise. */
async function ownChat(c, id) {
  needAgents(c);
  const chat = await mine(c).getChat(id);
  if (!chat) fail(404, "No such chat.");
  editor(c, grantFor(c.access, chat.tree));
  return chat;
}

async function ownChange(c, cid) {
  needAgents(c);
  const ch = await mine(c).change(cid);
  if (!ch) fail(404, "No such change.");
  const chat = await mine(c).getChat(ch.chat);
  if (!chat) fail(404, "No such change.");
  editor(c, grantFor(c.access, chat.tree));
  return { ch, chat };
}

export async function listChats(c, { grantOrFail }) {
  const g = grantOrFail(c);
  editor(c, g);
  if (!agentsEnabled(c.env)) return json({ chats: [], enabled: false });
  return json({ chats: await mine(c).listChats(g.tree_id), enabled: true });
}

export async function createChat(c, d, { grantOrFail }) {
  const g = grantOrFail(c, d.tree);
  editor(c, g);
  needAgents(c);
  return json({ chat: await mine(c).createChat(`chat-${crypto.randomUUID()}`, g.tree_id) }, 201);
}

/** Flue's conversation snapshot, reduced to what the panel shows: the editor's words (page context stripped), the
 *  assistant's text, and which tools it used. Signals and runtime plumbing stay hidden. */
function viewMessages(snap) {
  const out = [];
  for (const m of snap.messages || []) {
    if (m.display !== "visible") continue;
    const text = (m.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("");
    if (m.role === "user") out.push({ id: m.id, role: "user", text: stripContext(text), at: m.timestamp });
    else if (m.role === "assistant") {
      const parts = [];
      for (const p of m.parts || []) {
        if (p.type === "text" && p.text) parts.push({ type: "text", text: p.text, streaming: p.state === "streaming" || undefined });
        else if (p.type === "dynamic-tool") {
          const x = { type: "tool", tool: p.toolName, state: p.state === "output-error" ? "error" : p.state === "output-available" ? "done" : "running" };
          if (p.input && typeof p.input === "object") x.about = p.input.id || p.input.query || p.input.summary || (p.input.from && `${p.input.from} → ${p.input.to}`) || undefined;
          const o = p.output && typeof p.output === "object" && (p.output.output || p.output);
          if (p.toolName === "propose_change" && o && o.change) x.change = o.change;
          parts.push(x);
        }
      }
      if (parts.length) out.push({ id: m.id, role: "assistant", parts, at: m.timestamp });
    } else if (m.settlement) out.push({ id: m.id, role: "notice", text: m.settlement.outcome === "aborted" ? "Stopped." : "Something went wrong with that reply. Try again." });
  }
  const settled = new Set((snap.settlements || []).map((s) => s.submissionId));
  const busy = (snap.messages || []).some((m) => m.submissionId && !settled.has(m.submissionId));
  return { messages: out, busy };
}

export async function getChat(c, id) {
  const chat = await ownChat(c, id);
  let view = { messages: [], busy: false };
  try { view = viewMessages(await agentsFetch(c.env, `${CHAT_PATH}/${id}?limit=80`, undefined, "GET")); }
  catch (e) { if (e.status !== 404) throw e; } // no messages yet
  const changes = await mine(c).changes(id);
  return json({ chat, ...view, changes }, 200, { "Cache-Control": "private, no-store" });
}

export async function sendMessage(c, id, d, { scoped }) {
  const chat = await ownChat(c, id);
  const text = String(d.text || "").trim();
  if (!text) fail(400, "Say something.");
  if (text.length > MAX_TEXT) fail(400, `Keep messages under ${MAX_TEXT} characters.`);
  try { await checkDaily(c.env, settings(c.env)); } catch (e) { if (e instanceof BudgetError) fail(429, e.message); throw e; }
  const b = await scoped(c, grantFor(c.access, chat.tree));
  const body = composeMessage(text, pageContext(b, d.page));
  // initialData only counts when this message creates the conversation: it ties the agent to this editor and tree
  const adm = await agentsFetch(c.env, `${CHAT_PATH}/${id}`, { kind: "user", body, initialData: { principal: c.access.principal, tree: chat.tree } });
  await mine(c).touchChat(id, text);
  return json({ ok: true, submission: adm.submissionId }, 202);
}

export async function abortChat(c, id) {
  await ownChat(c, id);
  await agentsFetch(c.env, `${CHAT_PATH}/${id}/abort`, {}).catch(() => null);
  return json({ ok: true });
}

/** Tell the conversation what happened to a change, so the assistant's next reply knows. Best effort. */
async function tell(c, chatId, body) {
  await agentsFetch(c.env, `${CHAT_PATH}/${chatId}`, { kind: "signal", type: "change-outcome", tagName: "change_outcome", body }).catch((e) => console.error("chat signal failed", e.message));
}

/** The edit already written for this draft, if an earlier apply got that far (the D1 log carries `via`). */
const viaOf = (ch) => `${ch.chat}#${ch.id}`;
async function writtenBatch(env, ch) {
  const r = await env.DB.prepare("SELECT batch_id FROM changes WHERE via = ? AND op = 'edit' LIMIT 1").bind(viaOf(ch)).first();
  return r && r.batch_id;
}

export async function decideChange(c, cid, action) {
  const { ch } = await ownChange(c, cid);
  const env = c.env, who = c.access.principal, store = mine(c);
  const label = `change #${ch.id} ("${ch.summary}")`;
  const done = async (extra = {}) => json({ ok: true, change: await store.change(ch.id), ...extra });

  if (action === "undo") {
    if (ch.status !== "applied" || !ch.batch) fail(409, "Only an applied change can be undone.");
    try {
      // undoing is the editor's own act
      const r = await revertBatch(env, ch.batch, { actor: who, actorKind: "person", reason: `Undid ${label} from the page assistant` });
      if (!r) fail(404, "That edit is no longer in the history.");
    } catch (e) {
      if (isConflict(e) || e.conflict) fail(409, "Those records have changed since; undo the later changes first.");
      throw e;
    }
    await store.move(ch.id, "undone", { from: "applied" });
    await tell(c, ch.chat, `The editor undid ${label}. The tree is back as it was before it.`);
    return done();
  }

  if (action === "dismiss") {
    if (!(await store.move(ch.id, "dismissed", { from: "pending" }))) fail(409, `That change is already ${(await store.change(ch.id)).status}.`);
    await tell(c, ch.chat, `The editor dismissed ${label}. Nothing was changed.`);
    return done();
  }

  // apply. An apply interrupted after writing the edit left the draft "applying": settle it from the log.
  if (ch.status === "applying") {
    const b = await writtenBatch(env, ch);
    if (b) { await store.move(ch.id, "applied", { from: "applying", batch: b }); return done(); }
    await store.move(ch.id, "pending", { from: "applying" });
  } else if (ch.status !== "pending") fail(409, `That change is already ${ch.status}.`);
  // claim it in the Durable Object first, so a double click can't apply it twice
  if (!(await store.move(ch.id, "applying", { from: "pending" }))) fail(409, "That change is already being applied.");
  const failed = async (msg) => {
    await store.move(ch.id, "failed", { from: "applying", error: msg });
    await tell(c, ch.chat, `Applying ${label} failed: ${msg}. Nothing was changed.`);
    fail(409, `This change can't be applied any more: ${msg}`);
  };
  try {
    // re-check against the tree as it is now, as the editor
    const sc = await chatScope(env, { principal: who, tree: (await store.getChat(ch.chat)).tree });
    if (!sc) { await store.move(ch.id, "pending", { from: "applying" }); fail(403, "The assistant is for editors."); }
    const check = await checkChange(env, sc, ch.ops);
    if (check.errors) return await failed(check.errors.join("; "));
    // the change log records the assistant as the actor, on the editor's behalf, with the chat it came from
    const res = await applyAndCommit(env, ch.ops, { actor: ASSISTANT, actorKind: "agent", onBehalfOf: who, via: viaOf(ch), reason: ch.reason, sources: ch.sources, batchId: newBatchId() });
    if (!res.batchId) return await failed("the tree already says this");
    await store.move(ch.id, "applied", { from: "applying", batch: res.batchId });
    await tell(c, ch.chat, `The editor applied ${label}. It is saved in the tree's history as edit ${res.batchId}, made by you on their behalf, and can be undone from there.`);
    return done({ touched: res.touched, created: res.created });
  } catch (e) {
    const cur = await store.change(ch.id);
    if (cur && cur.status === "applying" && !(await writtenBatch(env, ch))) await store.move(ch.id, "pending", { from: "applying" });
    if (isConflict(e)) fail(409, "Someone changed these records meanwhile. Ask the assistant to look again.");
    throw e;
  }
}
