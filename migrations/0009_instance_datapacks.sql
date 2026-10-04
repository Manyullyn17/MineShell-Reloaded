-- Data packs installed from the mod browser into <level-name>/datapacks/.
-- Kept apart from instance_mods, whose rows all live in mods/ (the Mods list
-- and sync read that folder). file_name is relative to the datapacks folder,
-- which moves with level-name.
CREATE TABLE instance_datapacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  instance_id TEXT NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  project_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  project_url TEXT,
  icon_url TEXT,
  version TEXT,
  version_id TEXT,
  file_name TEXT NOT NULL,
  hash TEXT,
  installed_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX instance_datapacks_file_idx ON instance_datapacks (instance_id, file_name);
