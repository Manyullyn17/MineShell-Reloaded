-- When a run logged a crash ("Encountered an unexpected exception"), so a server
-- whose process hangs on after one is shown as crashed rather than running,
-- and the run counts as a crash even when it then had to be stopped.
ALTER TABLE server_runs ADD COLUMN crash_logged_at INTEGER;
