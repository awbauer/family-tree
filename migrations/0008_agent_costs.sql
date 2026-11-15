-- Agent costs and the assistant's page context. Additive only.
-- Spend is recorded in US dollars, priced per model (worker/agent/models.js), so budgets mean the same whichever
-- model each agent uses.
ALTER TABLE ai_usage ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE chats ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
-- The page assistant keeps the editor's current page on the chat (address, title, visible text) instead of sending it
-- with every message: the agent gets a short pointer when the page changes and reads the rest with read_page.
ALTER TABLE chats ADD COLUMN page TEXT;

UPDATE meta SET value = '8' WHERE key = 'schema' AND CAST(value AS INTEGER) < 8;
