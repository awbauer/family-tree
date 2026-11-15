-- The page assistant (worker/agent/chat.js). Chats and the changes they draft live in Durable Objects in the agents
-- Worker (one ChatStore per editor, one Flue conversation per chat), not here. What D1 gains is attribution: an edit
-- the assistant drafted and the editor applied is logged as made by the assistant on the editor's behalf.
-- Additive only: the current code keeps working after this runs.
ALTER TABLE changes ADD COLUMN on_behalf_of TEXT;   -- the person a software agent acted for (prov:actedOnBehalfOf)
ALTER TABLE changes ADD COLUMN via TEXT;            -- where the change was drafted, e.g. "chat-…#3"
CREATE INDEX changes_via ON changes(via);

UPDATE meta SET value = '6' WHERE key = 'schema';
