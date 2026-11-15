-- The page assistant keeps the editor's current page on the chat (address, title, visible text) instead of sending it
-- with every message: the agent gets a short pointer when the page changes and reads the rest with read_page.
-- Additive only.
ALTER TABLE chats ADD COLUMN page TEXT;

UPDATE meta SET value = '8' WHERE key = 'schema' AND CAST(value AS INTEGER) < 8;
