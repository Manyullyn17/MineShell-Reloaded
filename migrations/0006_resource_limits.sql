-- Per-server systemd resource limits (limits.conf drop-in). NULL: no limit.
-- Memory in MB (MemoryMax=), CPU in percent of one core (CPUQuota=, 200 = two cores).
ALTER TABLE server_instances ADD COLUMN limit_memory_mb INTEGER;
ALTER TABLE server_instances ADD COLUMN limit_cpu_percent INTEGER;
