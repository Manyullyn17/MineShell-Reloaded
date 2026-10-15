-- Periodic checks for a newer pack version or loader build (updatecheck.ts),
-- on by default, daily, releases only.
ALTER TABLE server_instances ADD COLUMN update_check INTEGER NOT NULL DEFAULT 1;
ALTER TABLE server_instances ADD COLUMN update_check_hours INTEGER NOT NULL DEFAULT 24;
ALTER TABLE server_instances ADD COLUMN update_channel TEXT NOT NULL DEFAULT 'release';
ALTER TABLE server_instances ADD COLUMN update_checked_at INTEGER;

CREATE TABLE update_notices (
  instance_id TEXT PRIMARY KEY NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  from_version TEXT NOT NULL,
  version_id TEXT NOT NULL,
  label TEXT NOT NULL,
  channel TEXT NOT NULL,
  found_at INTEGER NOT NULL,
  skipped INTEGER NOT NULL DEFAULT 0
);
