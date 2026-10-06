-- What MineShell does with a server after the computer starts (bootstart.ts):
-- if-running | always | never. wanted_running: the last thing asked of the
-- server was a start (start, restart) rather than a stop; a crash leaves it.
ALTER TABLE server_instances ADD COLUMN boot_start TEXT NOT NULL DEFAULT 'if-running';
ALTER TABLE server_instances ADD COLUMN wanted_running INTEGER NOT NULL DEFAULT 0;
