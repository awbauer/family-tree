-- Cloud research agents (the Flue agents Worker in agents/, via AI Gateway) and AI-maintained narrative content.
-- Additive only: the current code keeps working after this runs.

-- One row per research-agent run: the app's view of it. The conversation itself lives in the run's Flue Durable Object.
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  todo_id INTEGER, person_id TEXT, tree_id TEXT NOT NULL,
  started_by TEXT NOT NULL,                      -- the editor/owner whose scope the agent works in
  instructions TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  steps INTEGER NOT NULL DEFAULT 0, searches INTEGER NOT NULL DEFAULT 0, fetches INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  model TEXT, log TEXT NOT NULL DEFAULT '[]',     -- short step log shown in the UI
  result TEXT,                                    -- the validated submission (batch + edits)
  proposal_ids TEXT, error TEXT,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
);
CREATE INDEX agent_runs_created ON agent_runs(created_at);
CREATE INDEX agent_runs_todo ON agent_runs(todo_id);

-- Daily AI spend, shared by agent runs and the content job (budgets in dashboard variables).
CREATE TABLE ai_usage (day TEXT PRIMARY KEY, runs INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0);

-- AI-written profile per (deceased) person, regenerated when their facts change. Derived content, labelled as such.
CREATE TABLE profiles (
  person_id TEXT PRIMARY KEY, text TEXT NOT NULL, source_hash TEXT NOT NULL,
  model TEXT, generated_at TEXT NOT NULL
);

-- The content job (agents/src/content-jobs.js): one row per thing it keeps current ("story:<slug>"), with the hash of the
-- facts it last checked against, so unchanged items are skipped.
CREATE TABLE content_checks (key TEXT PRIMARY KEY, source_hash TEXT NOT NULL, checked_at TEXT NOT NULL, outcome TEXT);

UPDATE meta SET value = '3' WHERE key = 'schema';
