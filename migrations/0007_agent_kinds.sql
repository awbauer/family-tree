-- More kinds of agent run (issue #31 data quality review, #33 stories) in the agent_runs table research already uses.
-- Additive only: existing rows are research runs.
ALTER TABLE agent_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'research';  -- research | quality | story
ALTER TABLE agent_runs ADD COLUMN options TEXT;   -- JSON, per kind (quality: scope, person, limit, dry_run, items)
ALTER TABLE agent_runs ADD COLUMN report TEXT;    -- JSON, per kind (quality: one decision per item reviewed)

UPDATE meta SET value = '7' WHERE key = 'schema';
