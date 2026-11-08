-- downgrade: safe
-- Where a data pack from the mod browser was put: '' for the world's datapacks/, otherwise a
-- folder a data pack loader reads (config/openloader/packs), relative to the server folder.
-- An older version takes every row for the world's folder and finds those files missing there,
-- so it leaves them alone. The unique (instance_id, file_name) index stays: older versions'
-- upserts need it, and one file name is one pack, in whichever folder.
ALTER TABLE instance_datapacks ADD COLUMN folder TEXT NOT NULL DEFAULT '';
