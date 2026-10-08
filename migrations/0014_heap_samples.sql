-- Memory advice (memoryadvice.ts): how much of the Java heap a running server
-- uses, read once a minute through the JVM's attach socket (heap.ts). The
-- cgroup memory in resource_samples cannot say: Java keeps heap it no longer
-- uses. Kept three days.
CREATE TABLE heap_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  instance_id TEXT NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  timestamp INTEGER NOT NULL,
  used_bytes INTEGER NOT NULL,
  max_bytes INTEGER NOT NULL
);
CREATE INDEX heap_samples_instance_time_idx ON heap_samples (instance_id, timestamp);
