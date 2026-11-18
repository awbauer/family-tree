-- Read-only SQL views over the tree: the people, names, events, family members, family events and citations held in
-- the JSON records, as rows and columns, for queries in the D1 console, Time Travel snapshots, exports and any tool
-- that reads D1 directly. The JSON records stay the source of truth: nothing writes through these views, and the app
-- doesn't read them. They work in both storage layouts (meta.storage): 'working' (people/families rows in the app's
-- model) and 'gedcomx' (GEDCOM X Persons in people, families as relationships). docs/agents/operations.md → SQL views.
--
-- D1 allows only a few terms in one compound SELECT, so each view picks the layout per row (`gx`) instead of
-- UNIONing a SELECT per layout, and the rest are split into nested compounds of two or three terms.
-- tests/helpers/fake-env.mjs applies D1's limits so the tests catch this.
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
DROP VIEW IF EXISTS tree_layout;

-- 1 when the tree is stored as GEDCOM X, else 0.
CREATE VIEW tree_layout AS
SELECT COALESCE((SELECT value FROM meta WHERE key = 'storage'), 'working') = 'gedcomx' AS gx;

-- One row per name, in order (name_index 0 is the main name).
CREATE VIEW tree_person_names AS
SELECT p.id AS person_id, CAST(n.key AS INTEGER) AS name_index,
  CASE WHEN l.gx THEN json_extract(n.value, '$.id') ELSE json_extract(n.value, '$.fid') END AS fid,
  CASE WHEN l.gx THEN (SELECT json_extract(pt.value, '$.value') FROM json_each(n.value, '$.nameForms[0].parts') pt WHERE json_extract(pt.value, '$.type') = 'http://gedcomx.org/Given')
    ELSE json_extract(n.value, '$.given') END AS given,
  CASE WHEN l.gx THEN (SELECT json_extract(pt.value, '$.value') FROM json_each(n.value, '$.nameForms[0].parts') pt WHERE json_extract(pt.value, '$.type') = 'http://gedcomx.org/Surname')
    ELSE json_extract(n.value, '$.surname') END AS surname,
  CASE WHEN l.gx THEN (SELECT json_extract(pt.value, '$.value') FROM json_each(n.value, '$.nameForms[0].parts') pt WHERE json_extract(pt.value, '$.type') = 'http://gedcomx.org/Suffix')
    ELSE json_extract(n.value, '$.suffix') END AS suffix,
  CASE WHEN l.gx THEN json_extract(n.value, '$."https://family-tree.example/terms/nameType"') ELSE json_extract(n.value, '$.type') END AS name_type,
  CASE WHEN l.gx THEN json_extract(n.value, '$."https://family-tree.example/terms/reviewStatus"') ELSE json_extract(n.value, '$.review.status') END AS review_status
FROM tree_layout l, people p, json_each(p.data, '$.names') n;

-- One row per event (fact) of a person, in order.
CREATE VIEW tree_person_events AS
SELECT person_id, event_index, fid, type, date, place, value, note, age, review_status,
  CASE
    WHEN formal GLOB '[+-][0-9][0-9][0-9][0-9]*' THEN CAST(substr(formal, 2, 4) AS INTEGER)
    WHEN trim(date) GLOB '*[0-9][0-9][0-9][0-9]' AND NOT trim(date) GLOB '*[0-9][0-9][0-9][0-9][0-9]' THEN CAST(substr(trim(date), -4) AS INTEGER)
    WHEN trim(date) GLOB '[0-9][0-9][0-9][0-9]*' AND NOT trim(date) GLOB '[0-9][0-9][0-9][0-9][0-9]*' THEN CAST(substr(trim(date), 1, 4) AS INTEGER)
  END AS year
FROM (
  SELECT p.id AS person_id, CAST(e.key AS INTEGER) AS event_index,
    CASE WHEN l.gx THEN json_extract(e.value, '$.id') ELSE json_extract(e.value, '$.fid') END AS fid,
    CASE WHEN l.gx THEN json_extract(e.value, '$."https://family-tree.example/terms/type"') ELSE json_extract(e.value, '$.type') END AS type,
    CASE WHEN l.gx THEN json_extract(e.value, '$.date.original') ELSE json_extract(e.value, '$.date') END AS date,
    CASE WHEN l.gx THEN json_extract(e.value, '$.date.formal') END AS formal,
    CASE WHEN l.gx THEN json_extract(e.value, '$.place.original') ELSE json_extract(e.value, '$.place') END AS place,
    json_extract(e.value, '$.value') AS value,
    CASE WHEN l.gx THEN json_extract(e.value, '$.notes[0].text') ELSE json_extract(e.value, '$.note') END AS note,
    CASE WHEN l.gx THEN json_extract(e.value, '$.qualifiers[0].value') ELSE json_extract(e.value, '$.age') END AS age,
    CASE WHEN l.gx THEN json_extract(e.value, '$."https://family-tree.example/terms/reviewStatus"') ELSE json_extract(e.value, '$.review.status') END AS review_status
  FROM tree_layout l, people p, json_each(p.data, CASE WHEN l.gx THEN '$.facts' ELSE '$.events' END) e
);

-- One row per person: sex, main name, and their first birth, death and burial events.
CREATE VIEW tree_people AS
SELECT p.id,
  CASE WHEN NOT l.gx THEN json_extract(p.data, '$.sex')
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
FROM tree_layout l, people p
LEFT JOIN tree_person_names n ON n.person_id = p.id AND n.name_index = 0
LEFT JOIN tree_person_events b ON b.person_id = p.id AND b.event_index = (SELECT MIN(event_index) FROM tree_person_events x WHERE x.person_id = p.id AND x.type = 'Birth')
LEFT JOIN tree_person_events d ON d.person_id = p.id AND d.event_index = (SELECT MIN(event_index) FROM tree_person_events x WHERE x.person_id = p.id AND x.type = 'Death')
LEFT JOIN tree_person_events u ON u.person_id = p.id AND u.event_index = (SELECT MIN(event_index) FROM tree_person_events x WHERE x.person_id = p.id AND x.type = 'Burial');

-- Who is in each family: role 'husband', 'wife' or 'child' (child_index keeps the children's order).
CREATE VIEW tree_family_members AS
SELECT * FROM (
  -- working layout: the spouses, then the children
  SELECT f.id AS family_id, json_extract(s.value, '$.p') AS person_id, json_extract(s.value, '$.r') AS role, NULL AS child_index
  FROM tree_layout l, families f, json_each(json_array(
    json_object('p', json_extract(f.data, '$.husband'), 'r', 'husband'), json_object('p', json_extract(f.data, '$.wife'), 'r', 'wife'))) s
  WHERE NOT l.gx AND json_extract(s.value, '$.p') IS NOT NULL
  UNION ALL
  SELECT f.id, c.value, 'child', CAST(c.key AS INTEGER)
  FROM tree_layout l, families f, json_each(f.data, '$.children') c WHERE NOT l.gx
)
UNION ALL
SELECT * FROM (
  -- GEDCOM X: spouses from Couple (person1 = husband, person2 = wife) and FamilyGroup (one spouse, with its role)
  SELECT r.family, substr(json_extract(s.value, '$.p'), 2), json_extract(s.value, '$.r'), NULL
  FROM tree_layout l, relationships r, json_each(json_array(
    json_object('p', json_extract(r.data, '$.person1.resource'),
      'r', CASE WHEN r.type = 'http://gedcomx.org/Couple' THEN 'husband' ELSE json_extract(r.data, '$."https://family-tree.example/terms/role"') END),
    json_object('p', json_extract(r.data, '$.person2.resource'), 'r', 'wife'))) s
  WHERE l.gx AND r.type IN ('http://gedcomx.org/Couple', 'https://family-tree.example/terms/FamilyGroup') AND json_extract(s.value, '$.p') IS NOT NULL
  UNION ALL
  -- children: one ParentChild per parent, so each child once
  SELECT r.family, substr(json_extract(r.data, '$.person2.resource'), 2), 'child', MIN(json_extract(r.data, '$."https://family-tree.example/terms/childIndex"'))
  FROM tree_layout l, relationships r WHERE l.gx AND r.type = 'http://gedcomx.org/ParentChild'
  GROUP BY r.family, json_extract(r.data, '$.person2.resource')
  UNION ALL
  -- a family with no known parent lists its children on its FamilyGroup
  SELECT r.family, c.value, 'child', CAST(c.key AS INTEGER)
  FROM tree_layout l, relationships r, json_each(r.data, '$."https://family-tree.example/terms/children"') c
  WHERE l.gx AND r.type = 'https://family-tree.example/terms/FamilyGroup'
);

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
  FROM tree_layout l, families f, json_each(f.data, '$.events') e WHERE NOT l.gx
  UNION ALL
  SELECT r.family, CAST(e.key AS INTEGER), json_extract(e.value, '$.id'), json_extract(e.value, '$."https://family-tree.example/terms/type"'),
    json_extract(e.value, '$.date.original'), json_extract(e.value, '$.date.formal'), json_extract(e.value, '$.place.original'),
    json_extract(e.value, '$.value'), json_extract(e.value, '$.notes[0].text')
  FROM tree_layout l, relationships r, json_each(r.data, '$.facts') e
  WHERE l.gx AND r.type IN ('http://gedcomx.org/Couple', 'https://family-tree.example/terms/FamilyGroup')
);

-- Every citation: on a person, one of their names or events, or a family event. source_id is the catalogued source
-- (S…), or NULL for a citation that only names its record (title/url). Citations are the `citations` lists (working
-- layout) or `sources` lists (GEDCOM X SourceReferences) anywhere in a record; `fid` is the name or event holding
-- the list, or NULL for the person's own.
CREATE VIEW tree_citations AS
SELECT entity_type, entity_id, fid, citation_index,
  CASE WHEN gx THEN substr(json_extract(c, '$.description'), 2) ELSE json_extract(c, '$.source') END AS source_id,
  CASE WHEN gx THEN json_extract(c, '$."https://family-tree.example/terms/title"') ELSE json_extract(c, '$.title') END AS title,
  CASE WHEN gx THEN json_extract(c, '$."https://family-tree.example/terms/page"') ELSE json_extract(c, '$.page') END AS page,
  CASE WHEN gx THEN json_extract(c, '$."https://family-tree.example/terms/url"') ELSE json_extract(c, '$.url') END AS url,
  CASE WHEN gx THEN json_extract(c, '$."https://family-tree.example/terms/text"') ELSE json_extract(c, '$.text') END AS text,
  CASE WHEN gx THEN json_extract(c, '$."https://family-tree.example/terms/note"') ELSE json_extract(c, '$.note') END AS note
FROM (
  SELECT l.gx, 'person' AS entity_type, p.id AS entity_id,
    CASE WHEN t.path = '$' THEN NULL ELSE json_extract(p.data, t.path || CASE WHEN l.gx THEN '.id' ELSE '.fid' END) END AS fid,
    CAST(c.key AS INTEGER) AS citation_index, c.value AS c
  FROM tree_layout l, people p, json_tree(p.data) t, json_each(t.value) c
  WHERE t.type = 'array' AND t.key = CASE WHEN l.gx THEN 'sources' ELSE 'citations' END
    AND (t.path = '$' OR t.path GLOB CASE WHEN l.gx THEN '$.facts[[]*]' ELSE '$.events[[]*]' END OR t.path GLOB '$.names[[]*]')
  UNION ALL
  SELECT l.gx, 'family', COALESCE(r.family, f.id),
    json_extract(COALESCE(r.data, f.data), t.path || CASE WHEN l.gx THEN '.id' ELSE '.fid' END),
    CAST(c.key AS INTEGER), c.value
  FROM tree_layout l
  LEFT JOIN families f ON NOT l.gx
  LEFT JOIN relationships r ON l.gx AND r.type IN ('http://gedcomx.org/Couple', 'https://family-tree.example/terms/FamilyGroup'),
  json_tree(COALESCE(r.data, f.data)) t, json_each(t.value) c
  WHERE (f.id IS NOT NULL OR r.id IS NOT NULL) AND t.type = 'array' AND t.key = CASE WHEN l.gx THEN 'sources' ELSE 'citations' END
    AND t.path GLOB CASE WHEN l.gx THEN '$.facts[[]*]' ELSE '$.events[[]*]' END
);
