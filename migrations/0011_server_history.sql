-- What happened on each server over time, read from its journal by history.ts:
-- runs (when a start began, reached "Done (", ended) for start times, and
-- player sessions (join to leave) for peak players, time online and playtime.
CREATE TABLE server_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  instance_id TEXT NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  invocation TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  done_at INTEGER,
  ended_at INTEGER
);
CREATE UNIQUE INDEX server_runs_invocation_idx ON server_runs (instance_id, invocation);

CREATE TABLE player_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  instance_id TEXT NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  player TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  left_at INTEGER
);
CREATE INDEX player_sessions_instance_idx ON player_sessions (instance_id, joined_at);

-- Where history.ts got to in the server's journal; null: not read yet.
ALTER TABLE server_instances ADD COLUMN history_cursor TEXT;
