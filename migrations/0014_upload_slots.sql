-- One-time upload links (worker/upload-slots.js). An AI client that holds a file in its own workspace asks for a link
-- over MCP (get_upload_link) and sends the file to it with one PUT, instead of writing the whole file out as base64 in a
-- tool call. Only a hash of the token is kept; a slot works once, for a few minutes, as the member who asked for it.
CREATE TABLE IF NOT EXISTS upload_slots (
  token_hash TEXT PRIMARY KEY,   -- SHA-256 of the token in the link (hex)
  principal TEXT NOT NULL,       -- who asked for it; the upload runs as them, with their access at the time of upload
  tree_id TEXT NOT NULL,
  kind TEXT NOT NULL,            -- 'attachment' (attached to people like add_attachment) or 'photo' (like upload_media)
  params TEXT NOT NULL,          -- JSON: name, title, people, source
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,                  -- set when an upload starts; cleared again if it fails, so the link can be retried
  result TEXT                    -- JSON: what the upload created
);
CREATE INDEX IF NOT EXISTS upload_slots_principal ON upload_slots (principal, created_at);
