-- Places as records (docs/design/edit-ops.md → Places). One row per place, in the working model:
--   {name, type?, parent?, lat?, lng?, names?: [{name, from?, to?}], texts?: [place text], match?: [pattern], note?, order?}
-- `name` is the place's own name ("Fenwick Row"); its full name is built up its `parent` chain
-- ("Fenwick Row, Leeds, England"). Facts point at a place with `place_ref` (GEDCOM X place.descriptionRef)
-- and keep their place text as the record wrote it; facts without one are matched by `texts`, then `match` patterns.
--
-- Filled from the places.json gazetteer (config `places`, keeping its order, which its patterns rely on) and the
-- places saved in the app since (config `place_map`). Both config rows stay as they were and are no longer read.
CREATE TABLE IF NOT EXISTS place_records (
  id TEXT PRIMARY KEY,           -- the place key: lower-case letters, digits and hyphens (leeds, fenwick-row-14)
  data TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT,
  updated_by TEXT
);

INSERT OR IGNORE INTO place_records (id, data, updated_at, updated_by)
SELECT json_extract(p.value, '$.key'), json_set(json_remove(p.value, '$.key'), '$.order', p.key),
       strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 'migration'
FROM config c, json_each(c.value, '$.places') p
WHERE c.key = 'places' AND json_type(p.value, '$.key') = 'text';

-- a place saved in the app over a places.json key changes it …
UPDATE place_records SET data = json_patch(data, (
  SELECT e.value FROM config c, json_each(c.value) e WHERE c.key = 'place_map' AND e.key = place_records.id))
WHERE id IN (SELECT e.key FROM config c, json_each(c.value) e WHERE c.key = 'place_map' AND json_extract(e.value, '$.removed') IS NULL);

-- … or takes it off the map
DELETE FROM place_records
WHERE id IN (SELECT e.key FROM config c, json_each(c.value) e WHERE c.key = 'place_map' AND json_extract(e.value, '$.removed') IS NOT NULL);

-- and a new key is a new place
INSERT OR IGNORE INTO place_records (id, data, updated_at, updated_by)
SELECT e.key, e.value, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 'migration'
FROM config c, json_each(c.value) e
WHERE c.key = 'place_map' AND json_extract(e.value, '$.removed') IS NULL
  AND json_extract(e.value, '$.lat') IS NOT NULL AND json_extract(e.value, '$.lng') IS NOT NULL;

UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'data_version';
