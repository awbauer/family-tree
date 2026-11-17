-- Keep earlier model output private if the viewer later loses access to part of the tree.
ALTER TABLE chats ADD COLUMN scope_access TEXT;
ALTER TABLE agent_runs ADD COLUMN scope_access TEXT;
UPDATE meta SET value = '11' WHERE key = 'schema' AND CAST(value AS INTEGER) < 11;
