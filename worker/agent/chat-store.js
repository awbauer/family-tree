// One editor's chats and the changes the assistant drafted in them. It runs inside a Durable Object in the agents
// Worker (agents/src/cloudflare.js → ChatStore, one object per editor, addressed by their principal), so a chat is
// only ever reachable through its owner's object. The logic is plain code over a `sql(query, ...bindings) → rows`
// function: the Durable Object passes its SQLite storage, tests pass node:sqlite.
//
// A drafted change moves pending → applying → applied (or back to pending, or failed). "applying" is claimed in the
// object before the edit is written to D1, so two clicks can't apply it twice; the edit row in D1 carries
// via = "<chat>#<change>", which settles a change whose apply was interrupted.
const now = () => new Date().toISOString();
const J = (v) => JSON.stringify(v);
const parse = (s, d = null) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY, tree_id TEXT NOT NULL, title TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL,
    summary TEXT NOT NULL, reason TEXT NOT NULL, sources TEXT, ops TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', batch_id TEXT, error TEXT,
    created_at TEXT NOT NULL, decided_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS changes_chat ON changes(chat_id)`,
];

export const STATUSES = ["pending", "applying", "applied", "dismissed", "superseded", "failed", "undone"];
const MOVES = { // allowed transitions
  pending: ["applying", "dismissed", "superseded"],
  applying: ["applied", "pending", "failed"],
  applied: ["undone"],
};

const chatOut = (r) => r && ({ id: r.id, tree: r.tree_id, title: r.title, created_at: r.created_at, updated_at: r.updated_at, tokens: { input: r.input_tokens, output: r.output_tokens } });
const changeOut = (r) => r && ({
  id: r.id, chat: r.chat_id, summary: r.summary, reason: r.reason, sources: parse(r.sources, undefined), ops: parse(r.ops, []),
  status: r.status, batch: r.batch_id || null, error: r.error || null, created_at: r.created_at, decided_at: r.decided_at || null,
});

export class ChatBook {
  /** @param sql (query, ...bindings) => array of row objects */
  constructor(sql) {
    this.sql = sql;
    for (const q of SCHEMA) sql(q);
  }
  one(q, ...b) { return this.sql(q, ...b)[0] || null; }

  // ---------------------------------------------------------------- chats
  createChat(id, tree) {
    if (!/^chat-[\w-]+$/.test(String(id)) || !tree) throw new Error("bad chat");
    const t = now();
    this.sql("INSERT INTO chats (id, tree_id, created_at, updated_at) VALUES (?, ?, ?, ?)", id, String(tree), t, t);
    return this.getChat(id);
  }
  getChat(id) { return chatOut(this.one("SELECT * FROM chats WHERE id = ?", String(id))); }
  listChats(tree) { return this.sql("SELECT * FROM chats WHERE tree_id = ? ORDER BY updated_at DESC LIMIT 20", String(tree)).map(chatOut); }
  touchChat(id, title) {
    this.sql("UPDATE chats SET updated_at = ?, title = COALESCE(title, ?) WHERE id = ?", now(), title ? String(title).slice(0, 80) : null, String(id));
    return this.getChat(id);
  }
  addUsage(id, { input = 0, output = 0 } = {}) {
    this.sql("UPDATE chats SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?", +input || 0, +output || 0, String(id));
    return true;
  }

  // ---------------------------------------------------------------- drafted changes
  /** File a draft; it replaces any draft still waiting in the same chat. */
  propose(chatId, { summary, reason, sources, ops }) {
    if (!this.getChat(chatId)) throw new Error("no such chat");
    const t = now();
    this.sql("UPDATE changes SET status = 'superseded', decided_at = ? WHERE chat_id = ? AND status = 'pending'", t, String(chatId));
    const r = this.one("INSERT INTO changes (chat_id, summary, reason, sources, ops, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
      String(chatId), String(summary), String(reason), sources && sources.length ? J(sources) : null, J(ops), t);
    return this.change(r.id);
  }
  change(id) { return changeOut(this.one("SELECT * FROM changes WHERE id = ?", +id)); }
  changes(chatId) { return this.sql("SELECT * FROM changes WHERE chat_id = ? ORDER BY id", String(chatId)).map(changeOut); }

  /** Move a change to `to` if it is currently `from` (or any state allowed to reach `to` when `from` is omitted).
   *  Returns the updated change, or null when it wasn't in that state (someone else got there first). */
  move(id, to, { from, batch, error } = {}) {
    const cur = this.change(id);
    if (!cur) return null;
    const ok = from ? cur.status === from : true;
    if (!ok || !(MOVES[cur.status] || []).includes(to)) return null;
    this.sql("UPDATE changes SET status = ?, batch_id = COALESCE(?, batch_id), error = ?, decided_at = ? WHERE id = ? AND status = ?",
      to, batch || null, error || null, now(), +id, cur.status);
    return this.change(id);
  }
}

/** Methods the site Worker may call over the service binding (agents/src/app.js → /internal/chats/:principal). */
export const REMOTE_METHODS = ["createChat", "getChat", "listChats", "touchChat", "changes", "change", "move"];
