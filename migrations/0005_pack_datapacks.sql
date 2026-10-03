-- The data packs the installed pack version put into the world's datapacks/
-- folder (JSON array of names), so a pack version change knows which ones the
-- pack owns - and can remove those the new version dropped - without touching
-- data packs the user added. NULL: installed before this was recorded.
ALTER TABLE server_instances ADD COLUMN pack_datapacks TEXT;
