-- What the AI Search index holds (worker/ai-search.js): one row per uploaded document, with its content hash, so a
-- sync uploads only what changed and removes what's gone.
CREATE TABLE IF NOT EXISTS ai_search_items (
  key TEXT PRIMARY KEY,          -- the document's key in the index: person/I12.md, story/<slug>.md, attachments/<id>.pdf …
  item_id TEXT,                  -- AI Search's item id (for delete)
  hash TEXT NOT NULL,            -- SHA-256 of what was uploaded
  indexed_at TEXT NOT NULL
);
