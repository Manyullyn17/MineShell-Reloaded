-- Committed pack version changes, for rolling one back (packrollback.ts): the
-- version the server was on, where its configs went, the snapshot taken first.
CREATE TABLE pack_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  instance_id TEXT NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  changed_at INTEGER NOT NULL,
  from_version_id TEXT,
  from_version_name TEXT,
  from_minecraft TEXT NOT NULL,
  to_version_id TEXT,
  to_version_name TEXT,
  old_configs TEXT,
  configs_moved TEXT NOT NULL,
  configs_created TEXT NOT NULL,
  snapshot_id TEXT,
  updated_mods TEXT NOT NULL,
  user_mods_after TEXT,
  rolled_back_at INTEGER
);
CREATE INDEX pack_changes_instance_idx ON pack_changes (instance_id, changed_at);
