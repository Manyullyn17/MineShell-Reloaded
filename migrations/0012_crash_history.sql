-- Crash history on the runs history.ts keeps: how each run ended, whether
-- that was a crash, and the crash analyzer's verdict (diagnosed once).
ALTER TABLE server_runs ADD COLUMN exit_status INTEGER;
ALTER TABLE server_runs ADD COLUMN failed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE server_runs ADD COLUMN crashed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE server_runs ADD COLUMN cause TEXT;
ALTER TABLE server_runs ADD COLUMN diagnosed INTEGER NOT NULL DEFAULT 0;

-- Runs recorded before these columns existed lack their crash fields, and the
-- reader has passed their end lines. Everything here is read from the journal,
-- so it is cleared and read again from the start.
DELETE FROM player_sessions;
DELETE FROM server_runs;
UPDATE server_instances SET history_cursor = NULL;
