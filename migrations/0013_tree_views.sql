-- Read-only SQL views over the tree: the people, names, events, family members, family events and citations held in
-- the JSON records, as rows and columns, for queries in the D1 console, Time Travel snapshots, exports and any tool
-- that reads D1 directly. The JSON records stay the source of truth: nothing writes through these views, and the app
-- doesn't read them. They work in both storage layouts (meta.storage): 'working' (people/families rows in the app's
-- model) and 'gedcomx' (GEDCOM X Persons in people, families as relationships). docs/agents/operations.md → SQL views.
--
-- `year` columns are a best-effort reading of the date text (a four-digit year at the end or the start, or the
-- GEDCOM X formal date); dates like "Bet 1850 and 1860" give the last year, and dual dates (1750/51) give none.
-- The app's own date parsing (worker/derive.js) remains the reference.

DROP VIEW IF EXISTS tree_people;
DROP VIEW IF EXISTS tree_person_names;
DROP VIEW IF EXISTS tree_person_events;
DROP VIEW IF EXISTS tree_family_members;
DROP VIEW IF EXISTS tree_family_events;
DROP VIEW IF EXISTS tree_citations;

-- One row per name, in order (name_index 0 is the main name).
CREATE VIEW tree_person_names AS
SELECT p.id AS person_id, CAST(n.key AS INTEGER) AS name_index,
  json_extract(n.value, '$.fid') AS fid,
  json_extract(n.value, '$.given') AS given, json_extract(n.value, '$.surname') AS surname,
  json_extract(n.value, '$.suffix') AS suffix, json_extract(n.value, '$.type') AS name_type,
  json_extract(n.value, '$.review.status') AS review_status
FROM people p, json_each(p.data, '$.names') n
WHERE COALESCE((SELECT value FROM meta WHERE key = 'storage'), 'working') <> 'gedcomx'
UNION ALL
SELECT p.id, CAST(n.key AS INTEGER),
  json_extract(n.value, '$.id'),
  (SELECT json_extract(pt.value, '$.value') FROM json_each(n.value, '$.nameForms[0].parts') pt WHERE json_extract(pt.value, '$.type') = 'http://gedcomx.org/Given'),
  (SELECT json_extract(pt.value, '$.value') FROM json_each(n.value, '$.nameForms[0].parts') pt WHERE json_extract(pt.value, '$.type') = 'http://gedcomx.org/Surname'),
  (SELECT json_extract(pt.value, '$.value') FROM json_each(n.value, '$.nameForms[0].parts') pt WHERE json_extract(pt.value, '$.type') = 'http://gedcomx.org/Suffix'),
  json_extract(n.value, '$."https://family-tree.example/terms/nameType"'),
  json_extract(n.value, '$."https://family-tree.example/terms/reviewStatus"')
FROM people p, json_each(p.data, '$.names') n
WHERE (SELECT value FROM meta WHERE key = 'storage') = 'gedcomx';

-- One row per event (fact) of a person, in order.
CREATE VIEW tree_person_events AS
SELECT person_id, event_index, fid, type, date, place, value, note, age, review_status,
  CASE
    WHEN formal GLOB '[+-][0-9][0-9][0-9][0-9]*' THEN CAST(substr(formal, 2, 4) AS INTEGER)
    WHEN trim(date) GLOB '*[0-9][0-9][0-9][0-9]' AND NOT trim(date) GLOB '*[0-9][0-9][0-9][0-9][0-9]' THEN CAST(substr(trim(date), -4) AS INTEGER)
    WHEN trim(date) GLOB '[0-9][0-9][0-9][0-9]*' AND NOT trim(date) GLOB '[0-9][0-9][0-9][0-9][0-9]*' THEN CAST(substr(trim(date), 1, 4) AS INTEGER)
  END AS year
FROM (
  SELECT p.id AS person_id, CAST(e.key AS INTEGER) AS event_index, json_extract(e.value, '$.fid') AS fid,
    json_extract(e.value, '$.type') AS type, json_extract(e.value, '$.date') AS date, NULL AS formal,
    json_extract(e.value, '$.place') AS place, json_extract(e.value, '$.value') AS value, json_extract(e.value, '$.note') AS note,
    json_extract(e.value, '$.age') AS age, json_extract(e.value, '$.review.status') AS review_status
  FROM people p, json_each(p.data, '$.events') e
  WHERE COALESCE((SELECT value FROM meta WHERE key = 'storage'), 'working') <> 'gedcomx'
  UNION ALL
  SELECT p.id, CAST(e.key AS INTEGER), json_extract(e.value, '$.id'),
    json_extract(e.value, '$."https://family-tree.example/terms/type"'), json_extract(e.value, '$.date.original'), json_extract(e.value, '$.date.formal'),
    json_extract(e.value, '$.place.original'), json_extract(e.value, '$.value'), json_extract(e.value, '$.notes[0].text'),
    json_extract(e.value, '$.qualifiers[0].value'), json_extract(e.value, '$."https://family-tree.example/terms/reviewStatus"')
  FROM people p, json_each(p.data, '$.facts') e
  WHERE (SELECT value FROM meta WHERE key = 'storage') = 'gedcomx'
);

-- One row per person: sex, main name, and their first birth, death and burial events.
CREATE VIEW tree_people AS
SELECT p.id,
  CASE WHEN COALESCE((SELECT value FROM meta WHERE key = 'storage'), 'working') <> 'gedcomx' THEN json_extract(p.data, '$.sex')
    ELSE COALESCE(json_extract(p.data, '$."https://family-tree.example/terms/sex"'),
      CASE json_extract(p.data, '$.gender.type') WHEN 'http://gedcomx.org/Male' THEN 'M' WHEN 'http://gedcomx.org/Female' THEN 'F' END) END AS sex,
  n.given, n.surname, n.suffix,
  trim(COALESCE(n.given, '') || ' ' || COALESCE(n.surname, '') || CASE WHEN COALESCE(n.suffix, '') <> '' THEN ' ' || n.suffix ELSE '' END) AS name,
  b.date AS birth_date, b.year AS birth_year, b.place AS birth_place,
  d.date AS death_date, d.year AS death_year, d.place AS death_place,
  u.date AS burial_date, u.place AS burial_place,
  (SELECT COUNT(*) FROM tree_person_names x WHERE x.person_id = p.id) AS name_count,
  (SELECT COUNT(*) FROM tree_person_events x WHERE x.person_id = p.id) AS event_count,
  p.version, p.updated_at, p.updated_by
FROM people p
LEFT JOIN tree_person_names n ON n.person_id = p.id AND n.name_index = 0
LEFT JOIN tree_person_events b ON b.person_id = p.id AND b.event_index = (SELECT MIN(event_index) FROM tree_person_events x WHERE x.person_id = p.id AND x.type = 'Birth')
LEFT JOIN tree_person_events d ON d.person_id = p.id AND d.event_index = (SELECT MIN(event_index) FROM tree_person_events x WHERE x.person_id = p.id AND x.type = 'Death')
LEFT JOIN tree_person_events u ON u.person_id = p.id AND u.event_index = (SELECT MIN(event_index) FROM tree_person_events x WHERE x.person_id = p.id AND x.type = 'Burial');

-- Who is in each family: role 'husband', 'wife' or 'child' (child_index keeps the children's order).
CREATE VIEW tree_family_members AS
SELECT f.id AS family_id, json_extract(f.data, '$.husband') AS person_id, 'husband' AS role, NULL AS child_index
FROM families f WHERE COALESCE((SELECT value FROM meta WHERE key = 'storage'), 'working') <> 'gedcomx' AND json_extract(f.data, '$.husband') IS NOT NULL
UNION ALL
SELECT f.id, json_extract(f.data, '$.wife'), 'wife', NULL
FROM families f WHERE COALESCE((SELECT value FROM meta WHERE key = 'storage'), 'working') <> 'gedcomx' AND json_extract(f.data, '$.wife') IS NOT NULL
UNION ALL
SELECT f.id, c.value, 'child', CAST(c.key AS INTEGER)
FROM families f, json_each(f.data, '$.children') c WHERE COALESCE((SELECT value FROM meta WHERE key = 'storage'), 'working') <> 'gedcomx'
UNION ALL
-- GEDCOM X: spouses from Couple (person1 = husband, person2 = wife) and FamilyGroup (one spouse, with its role)
SELECT r.family, substr(json_extract(r.data, '$.person1.resource'), 2), 'husband', NULL
FROM relationships r WHERE (SELECT value FROM meta WHERE key = 'storage') = 'gedcomx' AND r.type = 'http://gedcomx.org/Couple'
UNION ALL
SELECT r.family, substr(json_extract(r.data, '$.person2.resource'), 2), 'wife', NULL
FROM relationships r WHERE (SELECT value FROM meta WHERE key = 'storage') = 'gedcomx' AND r.type = 'http://gedcomx.org/Couple'
UNION ALL
SELECT r.family, substr(json_extract(r.data, '$.person1.resource'), 2), json_extract(r.data, '$."https://family-tree.example/terms/role"'), NULL
FROM relationships r WHERE (SELECT value FROM meta WHERE key = 'storage') = 'gedcomx' AND r.type = 'https://family-tree.example/terms/FamilyGroup'
  AND json_extract(r.data, '$.person1.resource') IS NOT NULL
UNION ALL
-- GEDCOM X children: one ParentChild per parent, so take each child once; a family with no known parent lists them
SELECT r.family, substr(json_extract(r.data, '$.person2.resource'), 2), 'child', MIN(json_extract(r.data, '$."https://family-tree.example/terms/childIndex"'))
FROM relationships r WHERE (SELECT value FROM meta WHERE key = 'storage') = 'gedcomx' AND r.type = 'http://gedcomx.org/ParentChild'
GROUP BY r.family, json_extract(r.data, '$.person2.resource')
UNION ALL
SELECT r.family, c.value, 'child', CAST(c.key AS INTEGER)
FROM relationships r, json_each(r.data, '$."https://family-tree.example/terms/children"') c
WHERE (SELECT value FROM meta WHERE key = 'storage') = 'gedcomx' AND r.type = 'https://family-tree.example/terms/FamilyGroup';

-- One row per family event (marriage, divorce, …).
CREATE VIEW tree_family_events AS
SELECT family_id, event_index, fid, type, date, place, value, note,
  CASE
    WHEN formal GLOB '[+-][0-9][0-9][0-9][0-9]*' THEN CAST(substr(formal, 2, 4) AS INTEGER)
    WHEN trim(date) GLOB '*[0-9][0-9][0-9][0-9]' AND NOT trim(date) GLOB '*[0-9][0-9][0-9][0-9][0-9]' THEN CAST(substr(trim(date), -4) AS INTEGER)
    WHEN trim(date) GLOB '[0-9][0-9][0-9][0-9]*' AND NOT trim(date) GLOB '[0-9][0-9][0-9][0-9][0-9]*' THEN CAST(substr(trim(date), 1, 4) AS INTEGER)
  END AS year
FROM (
  SELECT f.id AS family_id, CAST(e.key AS INTEGER) AS event_index, json_extract(e.value, '$.fid') AS fid, json_extract(e.value, '$.type') AS type,
    json_extract(e.value, '$.date') AS date, NULL AS formal, json_extract(e.value, '$.place') AS place,
    json_extract(e.value, '$.value') AS value, json_extract(e.value, '$.note') AS note
  FROM families f, json_each(f.data, '$.events') e
  WHERE COALESCE((SELECT value FROM meta WHERE key = 'storage'), 'working') <> 'gedcomx'
  UNION ALL
  SELECT r.family, CAST(e.key AS INTEGER), json_extract(e.value, '$.id'), json_extract(e.value, '$."https://family-tree.example/terms/type"'),
    json_extract(e.value, '$.date.original'), json_extract(e.value, '$.date.formal'), json_extract(e.value, '$.place.original'),
    json_extract(e.value, '$.value'), json_extract(e.value, '$.notes[0].text')
  FROM relationships r, json_each(r.data, '$.facts') e
  WHERE (SELECT value FROM meta WHERE key = 'storage') = 'gedcomx' AND r.type IN ('http://gedcomx.org/Couple', 'https://family-tree.example/terms/FamilyGroup')
);

-- Every citation: on a person, one of their names or events, or a family event. source_id is the catalogued source
-- (S…), or NULL for a citation that only names its record (title/url).
CREATE VIEW tree_citations AS
WITH working AS (SELECT 1 WHERE COALESCE((SELECT value FROM meta WHERE key = 'storage'), 'working') <> 'gedcomx'),
     gx AS (SELECT 1 WHERE (SELECT value FROM meta WHERE key = 'storage') = 'gedcomx')
SELECT 'person' AS entity_type, p.id AS entity_id, NULL AS fid, CAST(c.key AS INTEGER) AS citation_index,
  json_extract(c.value, '$.source') AS source_id, json_extract(c.value, '$.title') AS title, json_extract(c.value, '$.page') AS page,
  json_extract(c.value, '$.url') AS url, json_extract(c.value, '$.text') AS text, json_extract(c.value, '$.note') AS note
FROM working, people p, json_each(p.data, '$.citations') c
UNION ALL
SELECT 'person', p.id, json_extract(x.value, '$.fid'), CAST(c.key AS INTEGER), json_extract(c.value, '$.source'), json_extract(c.value, '$.title'),
  json_extract(c.value, '$.page'), json_extract(c.value, '$.url'), json_extract(c.value, '$.text'), json_extract(c.value, '$.note')
FROM working, people p, json_each(p.data, '$.events') x, json_each(x.value, '$.citations') c
UNION ALL
SELECT 'person', p.id, json_extract(x.value, '$.fid'), CAST(c.key AS INTEGER), json_extract(c.value, '$.source'), json_extract(c.value, '$.title'),
  json_extract(c.value, '$.page'), json_extract(c.value, '$.url'), json_extract(c.value, '$.text'), json_extract(c.value, '$.note')
FROM working, people p, json_each(p.data, '$.names') x, json_each(x.value, '$.citations') c
UNION ALL
SELECT 'family', f.id, json_extract(x.value, '$.fid'), CAST(c.key AS INTEGER), json_extract(c.value, '$.source'), json_extract(c.value, '$.title'),
  json_extract(c.value, '$.page'), json_extract(c.value, '$.url'), json_extract(c.value, '$.text'), json_extract(c.value, '$.note')
FROM working, families f, json_each(f.data, '$.events') x, json_each(x.value, '$.citations') c
UNION ALL
-- GEDCOM X: citations are SourceReferences (description = "#S…", the citation's fields under ft: terms)
SELECT 'person', p.id, NULL, CAST(c.key AS INTEGER), substr(json_extract(c.value, '$.description'), 2),
  json_extract(c.value, '$."https://family-tree.example/terms/title"'), json_extract(c.value, '$."https://family-tree.example/terms/page"'),
  json_extract(c.value, '$."https://family-tree.example/terms/url"'), json_extract(c.value, '$."https://family-tree.example/terms/text"'),
  json_extract(c.value, '$."https://family-tree.example/terms/note"')
FROM gx, people p, json_each(p.data, '$.sources') c
UNION ALL
SELECT 'person', p.id, json_extract(x.value, '$.id'), CAST(c.key AS INTEGER), substr(json_extract(c.value, '$.description'), 2),
  json_extract(c.value, '$."https://family-tree.example/terms/title"'), json_extract(c.value, '$."https://family-tree.example/terms/page"'),
  json_extract(c.value, '$."https://family-tree.example/terms/url"'), json_extract(c.value, '$."https://family-tree.example/terms/text"'),
  json_extract(c.value, '$."https://family-tree.example/terms/note"')
FROM gx, people p, json_each(p.data, '$.facts') x, json_each(x.value, '$.sources') c
UNION ALL
SELECT 'person', p.id, json_extract(x.value, '$.id'), CAST(c.key AS INTEGER), substr(json_extract(c.value, '$.description'), 2),
  json_extract(c.value, '$."https://family-tree.example/terms/title"'), json_extract(c.value, '$."https://family-tree.example/terms/page"'),
  json_extract(c.value, '$."https://family-tree.example/terms/url"'), json_extract(c.value, '$."https://family-tree.example/terms/text"'),
  json_extract(c.value, '$."https://family-tree.example/terms/note"')
FROM gx, people p, json_each(p.data, '$.names') x, json_each(x.value, '$.sources') c
UNION ALL
SELECT 'family', r.family, json_extract(x.value, '$.id'), CAST(c.key AS INTEGER), substr(json_extract(c.value, '$.description'), 2),
  json_extract(c.value, '$."https://family-tree.example/terms/title"'), json_extract(c.value, '$."https://family-tree.example/terms/page"'),
  json_extract(c.value, '$."https://family-tree.example/terms/url"'), json_extract(c.value, '$."https://family-tree.example/terms/text"'),
  json_extract(c.value, '$."https://family-tree.example/terms/note"')
FROM gx, relationships r, json_each(r.data, '$.facts') x, json_each(x.value, '$.sources') c
WHERE r.type IN ('http://gedcomx.org/Couple', 'https://family-tree.example/terms/FamilyGroup');
