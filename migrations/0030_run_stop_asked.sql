-- downgrade: safe
-- When systemd began stopping the run on request ("Stopping <unit>"): such a run
-- is not a crash, whatever its exit (Forge 1.12 stopped mid-startup exits 0).
ALTER TABLE server_runs ADD COLUMN stop_asked_at INTEGER;
