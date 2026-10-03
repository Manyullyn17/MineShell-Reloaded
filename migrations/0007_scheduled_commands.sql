-- Console commands run on a schedule (announcements, save-all), per server.
-- Exactly one of every_minutes / daily_time is set. next_at is when it runs
-- next; while the server is stopped it rolls forward without running.
CREATE TABLE scheduled_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  instance_id TEXT NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  every_minutes INTEGER,
  daily_time TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_at INTEGER,
  last_run_at INTEGER,
  last_result TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX scheduled_commands_instance_idx ON scheduled_commands (instance_id);
