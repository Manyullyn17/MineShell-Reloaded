-- Logs shared on mclo.gs (mclogs.ts): the public link and the token that
-- deletes it, per run (key = invocation id) or log file (key = its path).
CREATE TABLE log_shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  instance_id TEXT NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  log_key TEXT NOT NULL,
  paste_id TEXT NOT NULL,
  url TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE UNIQUE INDEX log_shares_log_idx ON log_shares (instance_id, kind, log_key);
