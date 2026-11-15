-- The page assistant (worker/agent/chat.js): editors chat with an agent from any page; it drafts tree changes and
-- the editor confirms each one before it is applied. Additive only: the current code keeps working after this runs.

-- One row per conversation. The conversation itself lives in the Flue Durable Object with the same id.
CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,                       -- the editor who owns it; only they can read or write it
  tree_id TEXT NOT NULL,
  title TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX chats_principal ON chats(principal, updated_at);

-- Changes the assistant drafted. Nothing reaches the tree until the editor applies one; then batch_id points at the
-- edit in `changes` (history, provenance and undo work as for a hand edit).
CREATE TABLE chat_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL, principal TEXT NOT NULL, tree_id TEXT NOT NULL,
  summary TEXT NOT NULL, reason TEXT NOT NULL, sources TEXT, ops TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dismissed', 'superseded', 'failed', 'undone')),
  batch_id TEXT, error TEXT,
  created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT
);
CREATE INDEX chat_changes_chat ON chat_changes(chat_id);

UPDATE meta SET value = '6' WHERE key = 'schema';
