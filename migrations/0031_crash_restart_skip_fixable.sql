-- downgrade: safe
-- Whether a crash while starting that has a one-click fix (a missing dependency)
-- cancels the restart systemd scheduled: it would fail the same way (crashhold.ts).
ALTER TABLE server_instances ADD COLUMN crash_restart_skip_fixable INTEGER NOT NULL DEFAULT 1;
