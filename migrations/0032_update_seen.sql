-- downgrade: safe
-- What the last successful update check saw: the pack version or loader build the server ran
-- and when it ran. An update found at the first check after the user installed or changed a
-- version (or a mod or data pack) is shown but not notified: it was there to see when they
-- picked it (updatecheck.ts).
ALTER TABLE server_instances ADD COLUMN update_seen_version TEXT;
ALTER TABLE server_instances ADD COLUMN update_seen_at INTEGER;
