-- downgrade: safe
-- Mods in the periodic update check (updatecheck.ts), for servers without a
-- pack: on by default. What the last check found, one row per server.
ALTER TABLE server_instances ADD COLUMN mod_update_check INTEGER NOT NULL DEFAULT 1;

CREATE TABLE mod_update_notices (
  instance_id TEXT PRIMARY KEY NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  updates TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  found_at INTEGER NOT NULL,
  skipped INTEGER NOT NULL DEFAULT 0
);
