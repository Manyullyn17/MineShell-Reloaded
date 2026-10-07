-- The mod bisect assistant (bisect.ts): when a search ran on a server, so the
-- runs it started are marked as tests (server_runs.bisect) and kept out of
-- crash history and start times.
CREATE TABLE bisect_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  instance_id TEXT NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX bisect_sessions_instance_idx ON bisect_sessions (instance_id);
ALTER TABLE server_runs ADD COLUMN bisect INTEGER NOT NULL DEFAULT 0;
