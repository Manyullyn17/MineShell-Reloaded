-- Journal of operations in progress on an instance (pack change, loader
-- switch, Cleanroom migration/revert, first install), so one interrupted by
-- MineShell itself stopping can be restored on the next start. A row exists
-- only while the operation runs; it is deleted in the same transaction that
-- commits the operation's result to server_instances.
CREATE TABLE operations (
  instance_id TEXT PRIMARY KEY NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  journal TEXT NOT NULL,
  process TEXT NOT NULL,
  started_at INTEGER NOT NULL
);
