-- Spend in US dollars, priced per model (worker/agent/models.js), so budgets mean the same whichever model each agent
-- uses. Additive only.
ALTER TABLE ai_usage ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE chats ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;

UPDATE meta SET value = '9' WHERE key = 'schema' AND CAST(value AS INTEGER) < 9;
