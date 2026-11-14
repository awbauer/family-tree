-- Editing (#5), fact review and comments (#6).

-- A batch of changes made by one edit (or one approved suggestion, or one revert) shares a batch_id,
-- and records each entity's version after the change so a revert can check nothing changed since.
ALTER TABLE changes ADD COLUMN batch_id TEXT;
ALTER TABLE changes ADD COLUMN version_after INTEGER;
CREATE INDEX changes_batch ON changes(batch_id);

-- Write guard: inserting NULL here fails the whole D1 batch (a transaction), which is how a stale version
-- aborts a multi-entity edit atomically: INSERT INTO _guard (x) SELECT NULL WHERE <conflict>.
CREATE TABLE _guard (x INTEGER NOT NULL);

-- Comments on a person or family, or on one fact (fid) of it.
CREATE TABLE comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('person', 'family')),
  entity_id TEXT NOT NULL, fid TEXT,
  author TEXT NOT NULL, body TEXT NOT NULL,
  created_at TEXT NOT NULL, edited_at TEXT,
  resolved_at TEXT, resolved_by TEXT
);
CREATE INDEX comments_entity ON comments(entity_type, entity_id);

-- Uploaded files (photos, documents) awaiting or attached; members' uploads arrive as suggestions.
CREATE TABLE uploads (
  key TEXT PRIMARY KEY, uploaded_by TEXT NOT NULL, uploaded_at TEXT NOT NULL,
  content_type TEXT NOT NULL, bytes INTEGER NOT NULL, original_name TEXT
);

UPDATE meta SET value = '2' WHERE key = 'schema';
