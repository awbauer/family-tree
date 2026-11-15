-- Provenance (docs/design/standards.md, phase 1). Additive only.

-- The evidence cited for each change (PROV-O prov:used). Edits always accepted `sources`; now they're kept.
ALTER TABLE changes ADD COLUMN sources TEXT;

-- What a cloud research run read: [{kind: "search"|"page", url?, query?, at}] (prov:used by the run's activity).
ALTER TABLE agent_runs ADD COLUMN used TEXT NOT NULL DEFAULT '[]';

UPDATE meta SET value = '4' WHERE key = 'schema';
