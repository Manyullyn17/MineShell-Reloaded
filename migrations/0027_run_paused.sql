-- downgrade: safe
-- When the running server paused itself for being empty (Minecraft 1.21.2+'s
-- pause-when-empty-seconds), cleared when a player joins: the overview shows it.
ALTER TABLE server_runs ADD COLUMN paused_at INTEGER;
