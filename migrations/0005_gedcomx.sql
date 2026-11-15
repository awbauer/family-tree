-- GEDCOM X storage (docs/design/standards.md, phases 2-4). Additive: nothing changes until the owner runs the
-- storage upgrade (POST /api/admin/storage), which converts the rows in one transaction and sets meta.storage.

-- Families are stored as GEDCOM X relationships: Couple, ParentChild, and ft:FamilyGroup for a family with one or
-- no known spouse. `family` is the derived family grouping each relationship belongs to (ft:family).
CREATE TABLE relationships (
  id TEXT PRIMARY KEY,
  family TEXT NOT NULL,
  type TEXT NOT NULL,                     -- relationship type URI
  person1 TEXT, person2 TEXT,             -- Couple: the spouses; ParentChild: parent, child
  data TEXT NOT NULL,                     -- the GEDCOM X Relationship (JSON)
  version INTEGER NOT NULL DEFAULT 1, updated_at TEXT, updated_by TEXT
);
CREATE INDEX relationships_family ON relationships(family);
CREATE INDEX relationships_person1 ON relationships(person1);
CREATE INDEX relationships_person2 ON relationships(person2);

-- 'working' (people/families rows in the app's working shape) until the upgrade; then 'gedcomx'
-- (people = GEDCOM X Person, sources/media = SourceDescription, families → relationships).
INSERT OR IGNORE INTO meta (key, value) VALUES ('storage', 'working');
UPDATE meta SET value = '5' WHERE key = 'schema';
