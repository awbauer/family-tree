-- D1 schema for the family-tree Worker.
-- Each row stores one entity as JSON (the shape tools/build.py produces), with a few
-- columns pulled out for indexing. Apply once:  npx wrangler d1 execute family-tree --remote --file worker/schema.sql
-- (build/seed.sql includes this too, so a fresh database can be loaded in one step.)
CREATE TABLE IF NOT EXISTS meta     (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS people   (id TEXT PRIMARY KEY, branch TEXT, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS families (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources  (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS media    (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS places   (key TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS findings (id INTEGER PRIMARY KEY, person_id TEXT, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stories  (slug TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS todos    (id INTEGER PRIMARY KEY, person_id TEXT, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS issues   (id INTEGER PRIMARY KEY, person_id TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_findings_person ON findings(person_id);
CREATE INDEX IF NOT EXISTS idx_todos_person ON todos(person_id);
