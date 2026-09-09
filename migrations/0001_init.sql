CREATE TABLE server_instances (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  minecraft_version TEXT NOT NULL,
  modloader TEXT NOT NULL DEFAULT 'vanilla',
  modloader_version TEXT,
  pack_source TEXT,
  pack_project_id TEXT,
  pack_version_id TEXT,
  pack_name TEXT,
  launch_args TEXT NOT NULL DEFAULT '-jar server.jar nogui',
  jvm_args TEXT NOT NULL DEFAULT '-Xms1G -Xmx4G',
  memory_max_mb INTEGER DEFAULT 4096,
  memory_min_mb INTEGER DEFAULT 1024,
  java_path TEXT,
  server_port INTEGER NOT NULL DEFAULT 25565,
  rcon_port INTEGER NOT NULL DEFAULT 25575,
  rcon_password_enc TEXT,
  restart_schedule TEXT NOT NULL DEFAULT 'none',
  restart_interval_hours INTEGER DEFAULT 6,
  restart_daily_time TEXT DEFAULT '05:00',
  restart_warn_minutes INTEGER NOT NULL DEFAULT 5,
  restart_skip_if_players INTEGER NOT NULL DEFAULT 0,
  restart_next_at INTEGER,
  auto_restart_on_crash INTEGER NOT NULL DEFAULT 1,
  crash_restart_limit INTEGER NOT NULL DEFAULT 5,
  crash_restart_window_sec INTEGER NOT NULL DEFAULT 600,
  console_backlog_lines INTEGER NOT NULL DEFAULT 300,
  console_buffer_lines INTEGER NOT NULL DEFAULT 2000,
  eula_accepted INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  status_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE mods (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  author TEXT,
  summary TEXT,
  project_url TEXT,
  icon_url TEXT
);
CREATE UNIQUE INDEX mods_source_slug_idx ON mods (source, slug);

CREATE TABLE instance_mods (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  instance_id TEXT NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  mod_id INTEGER NOT NULL REFERENCES mods(id) ON DELETE CASCADE,
  version TEXT,
  version_id TEXT,
  file_path TEXT NOT NULL,
  hash TEXT,
  hash_algo TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  from_pack INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  flags TEXT,
  installed_at INTEGER NOT NULL
);
CREATE INDEX instance_mods_instance_idx ON instance_mods (instance_id);
CREATE UNIQUE INDEX instance_mods_file_idx ON instance_mods (instance_id, file_path);

CREATE TABLE resource_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  instance_id TEXT NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  timestamp INTEGER NOT NULL,
  cpu_percent REAL NOT NULL,
  memory_bytes INTEGER NOT NULL
);
CREATE INDEX resource_samples_instance_ts_idx ON resource_samples (instance_id, timestamp);

CREATE TABLE java_runtimes (
  path TEXT PRIMARY KEY NOT NULL,
  major_version INTEGER NOT NULL,
  version_string TEXT NOT NULL,
  vendor TEXT,
  manual INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  timestamp INTEGER NOT NULL,
  instance_id TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  actor TEXT NOT NULL DEFAULT 'ui'
);
CREATE INDEX audit_log_ts_idx ON audit_log (timestamp);
