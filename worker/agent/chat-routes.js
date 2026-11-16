// HTTP routes for the page assistant (worker/agent/chat.js). Editors only; a chat belongs to the editor who started
// it and nobody else can read or write it. The conversation runs in the agents (Flue, agents/src/agents/
// assistant.js); this Worker owns the chat rows, adds the page context to each message, and applies changes the
// editor confirms.
//
//   GET  /api/chat?tree=                       your recent chats in this tree
//   POST /api/chat                             {tree}  start a chat
//   GET  /api/chat/:id                         the conversation (poll while busy) and the changes it drafted
//   POST /api/chat/:id/messages                {text, page: {path, title, text}}  send a message
//   POST /api/chat/:id/abort                   stop the reply in progress
//   POST /api/chat/changes/:cid/apply|dismiss|undo
import { J, now, parse } from "../db.js";
import { can, grantFor } from "../auth.js";
import { fail, json } from "../http.js";
import { applyAndCommit, revertBatch, isConflict, newBatchId } from "../store.js";
import { settings, agentsEnabled, checkDaily, BudgetError } from "./config.js";
import { agentsFetch } from "./routes.js";
import { S } from "../../strings/index.ts";
import { CHAT_PATH, ASSISTANT, chatOut, changeOut, loadChat, chatScope, checkChange, pageSnapshot, pageContext, composeMessage, stripContext } from "./chat.js";

const MAX_TEXT = 4000;

function editor(c, g) {
  if (!g || !can.review(g) || c.access.kind !== "person") fail(403, S.api.chat.editorsOnly);
}
function needAgents(c) {
  if (!agentsEnabled(c.env)) fail(503, S.api.chat.notSetUp);
}

/** The chat, if it is the caller's and they still edit its tree; 404 otherwise (never reveal other people's chats). */
async function ownChat(c, id) {
  const chat = await loadChat(c.env, id);
  if (!chat || chat.principal !== c.access.principal) fail(404, S.api.chat.noSuchChat);
  editor(c, grantFor(c.access, chat.tree_id));
  return chat;
}

async function ownChange(c, cid) {
  const row = await c.env.DB.prepare("SELECT * FROM chat_changes WHERE id = ?").bind(cid).first();
  if (!row || row.principal !== c.access.principal) fail(404, S.api.chat.noSuchChange);
  editor(c, grantFor(c.access, row.tree_id));
  return row;
}

export async function listChats(c, { grantOrFail }) {
  const g = grantOrFail(c);
  editor(c, g);
  const rows = (await c.env.DB.prepare("SELECT * FROM chats WHERE principal = ? AND tree_id = ? ORDER BY updated_at DESC LIMIT 20").bind(c.access.principal, g.tree_id).all()).results;
  return json({ chats: rows.map(chatOut), enabled: agentsEnabled(c.env) });
}

export async function createChat(c, d, { grantOrFail }) {
  const g = grantOrFail(c, d.tree);
  editor(c, g);
  needAgents(c);
  const id = `chat-${crypto.randomUUID()}`, t = now();
  await c.env.DB.prepare("INSERT INTO chats (id, principal, tree_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(id, c.access.principal, g.tree_id, t, t).run();
  return json({ chat: chatOut(await loadChat(c.env, id)) }, 201);
}

/** Flue's conversation snapshot, reduced to what the panel shows: the editor's words (page context stripped), the
 *  assistant's text, and which tools it used. Signals and runtime plumbing stay hidden. */
function viewMessages(snap) {
  const out = [];
  for (const m of snap.messages || []) {
    if (m.settlement) { out.push({ id: m.id, role: "notice", text: m.settlement.outcome === "aborted" ? S.api.chat.stopped : S.api.chat.replyFailed }); continue; }
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
          if (p.toolName === "get_source" || p.toolName === "read_record_file") {
            if (o?.title) x.about = o.title;
            if (o?.error) x.state = "error";
            else if (typeof o?.page === "string" && /^\/(person|source)\//.test(o.page)) x.page = o.page;
          }
          parts.push(x);
        }
      }
      if (parts.length) out.push({ id: m.id, role: "assistant", parts, at: m.timestamp });
    }
  }
  const settled = new Set((snap.settlements || []).map((s) => s.submissionId));
  const busy = (snap.messages || []).some((m) => m.submissionId && !settled.has(m.submissionId));
  return { messages: out, busy };
}

export async function getChat(c, id) {
  const chat = await ownChat(c, id);
  let view = { messages: [], busy: false };
  if (agentsEnabled(c.env)) {
    try { view = viewMessages(await agentsFetch(c.env, `${CHAT_PATH}/${id}?limit=80`, undefined, "GET")); }
    catch (e) { if (e.status !== 404) throw e; } // no messages yet
  }
  const changes = (await c.env.DB.prepare("SELECT * FROM chat_changes WHERE chat_id = ? ORDER BY id").bind(id).all()).results.map(changeOut);
  return json({ chat: chatOut(chat), ...view, changes }, 200, { "Cache-Control": "private, no-store" });
}

export async function sendMessage(c, id, d, { scoped }) {
  const chat = await ownChat(c, id);
  needAgents(c);
  const text = String(d.text || "").trim();
  if (!text) fail(400, S.api.chat.saySomething);
  if (text.length > MAX_TEXT) fail(400, S.api.chat.tooLong(MAX_TEXT));
  try { await checkDaily(c.env, settings(c.env), { chat: true }); } catch (e) { if (e instanceof BudgetError) fail(429, e.message); throw e; }
  const b = await scoped(c, grantFor(c.access, chat.tree_id));
  // The page pointer goes with a message only when the editor has moved to another page; the page's text is kept on
  // the chat for read_page.
  const snap = pageSnapshot(d.page);
  const prev = parse(chat.page, null);
  const moved = snap && (!prev || prev.key !== snap.key);
  const body = composeMessage(text, moved ? pageContext(b, snap) : "");
  const adm = await agentsFetch(c.env, `${CHAT_PATH}/${id}`, { kind: "user", body, initialData: { chatId: id } });
  await c.env.DB.prepare("UPDATE chats SET updated_at = ?, title = COALESCE(title, ?), page = COALESCE(?, page) WHERE id = ?").bind(now(), text.slice(0, 80), snap ? J(snap) : null, id).run();
  return json({ ok: true, submission: adm.submissionId }, 202);
}

export async function abortChat(c, id) {
  await ownChat(c, id);
  needAgents(c);
  await agentsFetch(c.env, `${CHAT_PATH}/${id}/abort`, {}).catch(() => null);
  return json({ ok: true });
}

/** Tell the conversation what happened to a change, so the assistant's next reply knows. Best effort. */
async function tell(c, chatId, body) {
  if (!agentsEnabled(c.env)) return;
  await agentsFetch(c.env, `${CHAT_PATH}/${chatId}`, { kind: "signal", type: "change-outcome", tagName: "change_outcome", body }).catch((e) => console.error("chat signal failed", e.message));
}

export async function decideChange(c, cid, action) {
  const row = await ownChange(c, cid);
  const env = c.env, t = now(), who = c.access.principal;
  const label = `change #${row.id} ("${row.summary}")`;
  if (action === "undo") {
    if (row.status !== "applied" || !row.batch_id) fail(409, S.api.chat.undoAppliedOnly);
    try {
      const r = await revertBatch(env, row.batch_id, { actor: who, actorKind: "person", reason: `Undid ${label} from the page assistant` });
      if (!r) fail(404, S.api.chat.editGone);
    } catch (e) {
      if (isConflict(e) || e.conflict) fail(409, S.api.chat.undoConflict);
      throw e;
    }
    await env.DB.prepare("UPDATE chat_changes SET status = 'undone', decided_at = ?, decided_by = ? WHERE id = ?").bind(t, who, row.id).run();
    await tell(c, row.chat_id, `The editor undid ${label}. The tree is back as it was before it.`);
    return json({ ok: true, change: changeOut(await ownChange(c, cid)) });
  }
  if (row.status !== "pending") fail(409, S.api.chat.alreadyDecided(row.status));
  if (action === "dismiss") {
    await env.DB.prepare("UPDATE chat_changes SET status = 'dismissed', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'").bind(t, who, row.id).run();
    await tell(c, row.chat_id, `The editor dismissed ${label}. Nothing was changed.`);
    return json({ ok: true, change: changeOut(await ownChange(c, cid)) });
  }
  // apply: re-check against the tree as it is now, as the editor, then commit like a hand edit
  const sc = await chatScope(env, { principal: who, tree_id: row.tree_id });
  if (!sc) fail(403, S.api.chat.editorsOnly);
  const ops = JSON.parse(row.ops);
  const check = await checkChange(env, sc, ops);
  const failed = async (msg) => {
    await env.DB.prepare("UPDATE chat_changes SET status = 'failed', error = ?, decided_at = ?, decided_by = ? WHERE id = ?").bind(msg, t, who, row.id).run();
    await tell(c, row.chat_id, `Applying ${label} failed: ${msg}. Nothing was changed.`);
    fail(409, S.api.chat.cantApply(msg));
  };
  if (check.errors) return failed(check.errors.join("; "));
  const batchId = newBatchId();
  const mark = env.DB.prepare("UPDATE chat_changes SET status = 'applied', batch_id = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'").bind(batchId, t, who, row.id);
  try {
    // logged as the assistant acting on the editor's behalf, with the chat and draft it came from
    const res = await applyAndCommit(env, ops, { actor: ASSISTANT, actorKind: "agent", onBehalfOf: who, via: `${row.chat_id}#${row.id}`, reason: row.reason, sources: row.sources ? JSON.parse(row.sources) : undefined, batchId, extra: [mark] });
    if (!res.batchId) return failed(S.api.chat.alreadyInTree);
    await tell(c, row.chat_id, `The editor applied ${label}. It is saved in the tree's history as edit ${res.batchId}, made by you on their behalf, and can be undone from there.`);
    return json({ ok: true, change: changeOut(await ownChange(c, cid)), touched: res.touched, created: res.created });
  } catch (e) {
    if (isConflict(e)) fail(409, S.api.chat.changedMeanwhile);
    throw e;
  }
}
