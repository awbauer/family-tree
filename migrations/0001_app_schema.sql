-- Schema for "the app is the source of truth" (docs/design/source-of-truth.md).
-- Apply with:  npx wrangler d1 migrations apply family-tree --remote -c wrangler.local.jsonc
-- then load the one-time import:  npm run db:import   (refuses once the app is the source of truth)
--
-- Stored data is RAW (as imported or edited). Everything derived (relationship labels, branches, living flag,
-- life summaries, data-quality issues) is computed by worker/derive.js at read time and cached per data_version.

-- Legacy snapshot tables from the old full-replace pipeline (worker/schema.sql) are replaced.
DROP TABLE IF EXISTS people;
DROP TABLE IF EXISTS families;
DROP TABLE IF EXISTS sources;
DROP TABLE IF EXISTS media;
DROP TABLE IF EXISTS places;
DROP TABLE IF EXISTS findings;
DROP TABLE IF EXISTS stories;
DROP TABLE IF EXISTS todos;
DROP TABLE IF EXISTS issues;
DROP TABLE IF EXISTS meta;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- keys: schema, source_of_truth ('import' until cutover, then 'app'), data_version (integer, bumped on every write)

-- ---------------------------------------------------------------- the tree (raw, JSON per row)
CREATE TABLE people   (id TEXT PRIMARY KEY, data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT, updated_by TEXT);
CREATE TABLE families (id TEXT PRIMARY KEY, data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT, updated_by TEXT);
CREATE TABLE sources  (id TEXT PRIMARY KEY, data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT, updated_by TEXT);
CREATE TABLE media    (id TEXT PRIMARY KEY, data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT, updated_by TEXT);

-- site settings and research configuration: site, home_person, core_people, branches, place_rules, overrides,
-- duplicates, methodology, context, places (gazetteer), media_map (photos attached to people), aliases
CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT, updated_by TEXT);

-- ---------------------------------------------------------------- research layer
CREATE TABLE findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, person_id TEXT, data TEXT NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL, proposal_id INTEGER, version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX findings_person ON findings(person_id);

CREATE TABLE statuses (person_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT, updated_by TEXT, version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE stories  (slug TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT, updated_by TEXT, version INTEGER NOT NULL DEFAULT 1);

CREATE TABLE research_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, person_id TEXT, data TEXT NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL, proposal_id INTEGER
);
CREATE INDEX research_log_person ON research_log(person_id);

-- ---------------------------------------------------------------- to-dos: the shared work queue (people and agents)
CREATE TABLE todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id TEXT,                                   -- optional; a to-do without a person belongs to tree_id
  tree_id TEXT,
  task TEXT NOT NULL,
  location TEXT,                                    -- "where to look"
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('high', 'medium', 'low')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'needs_review', 'done', 'wont_do')),
  assignee TEXT,                                    -- a principal: an email, or "agent:<name>" / "service:<id>"
  branch TEXT,
  outcome TEXT,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL, updated_by TEXT NOT NULL,
  closed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX todos_status ON todos(status, priority);
CREATE INDEX todos_assignee ON todos(assignee, status);
CREATE INDEX todos_person ON todos(person_id);

CREATE TABLE todo_events (                          -- history and comments for a to-do
  id INTEGER PRIMARY KEY AUTOINCREMENT, todo_id INTEGER NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('created', 'assigned', 'status', 'edited', 'comment', 'proposal')),
  data TEXT NOT NULL
);
CREATE INDEX todo_events_todo ON todo_events(todo_id);

-- ---------------------------------------------------------------- suggestions queue (members and agents propose; editors review)
CREATE TABLE proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL, author TEXT NOT NULL, author_kind TEXT NOT NULL CHECK (author_kind IN ('person', 'agent')),
  tree_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('research', 'edit')),   -- research: findings/log/statuses/stories/to-dos; edit: tree operations
  payload TEXT NOT NULL,
  rationale TEXT,
  todo_id INTEGER,                                  -- the to-do this work was for, if any
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected', 'withdrawn')),
  reviewed_by TEXT, reviewed_at TEXT, review_note TEXT
);
CREATE INDEX proposals_status ON proposals(status, tree_id);

-- ---------------------------------------------------------------- who can see what
CREATE TABLE members (
  principal TEXT PRIMARY KEY,                       -- lower-case email, or "service:<Access service token client id>"
  kind TEXT NOT NULL DEFAULT 'person' CHECK (kind IN ('person', 'agent')),
  display_name TEXT, person_id TEXT,
  is_owner INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, invited_by TEXT
);
CREATE TABLE trees (id TEXT PRIMARY KEY, name TEXT NOT NULL, definition TEXT NOT NULL, created_at TEXT, updated_at TEXT);
  -- definition: {"root": id?, "branches": ["*"] | [keys], "include": [ids], "exclude": [ids]}
CREATE TABLE views (id TEXT PRIMARY KEY, name TEXT NOT NULL, filter TEXT NOT NULL, created_at TEXT, updated_at TEXT);
  -- filter: {"living": "full"|"names-only"|"anonymous"|"hidden", "branches": [keys]?, "max_generations": n?,
  --          "research": bool, "notes": bool, "media": bool, "sources": bool, "exclude_people": [ids]}
CREATE TABLE grants (
  principal TEXT NOT NULL, tree_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('editor', 'member', 'agent')),
  view_id TEXT, granted_by TEXT, created_at TEXT,
  PRIMARY KEY (principal, tree_id)
);

-- ---------------------------------------------------------------- audit log (append-only)
CREATE TABLE changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, actor_kind TEXT NOT NULL,
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, op TEXT NOT NULL,
  before TEXT, after TEXT, reason TEXT, proposal_id INTEGER
);
CREATE INDEX changes_entity ON changes(entity_type, entity_id);

INSERT INTO meta (key, value) VALUES ('schema', '1'), ('source_of_truth', 'import'), ('data_version', '1');
